"""Apple ID sign-in against gsa.apple.com — the same GrandSlam/SRP-6a flow
Xcode performs, ported from AltSign's ALTAppleAPI+Authentication.

Successful authentication yields a ``Session`` (dsid + authToken) that
``provision.py`` uses to call developerservices2.apple.com.

Protocol outline:
  1. POST GsService2 {A2k, ps:[s2k,s2k_fo], u, o:"init", cpd}  → {sp, c, s, i, B}
  2. PBKDF2 the password per ``sp`` and answer the SRP challenge  → M1
  3. POST {c, M1, u, o:"complete"}                             → {M2, spd, sc, np, Status}
  4. Verify M2, verify the ``np`` negotiation HMAC, decrypt ``spd`` (AES-CBC with
     session-derived keys) → {adsid, GsIdmsToken, sk, c}
  5. If Status.au requests secondary auth → 2FA, then restart from step 1.
  6. Exchange for the Xcode app token: {u, app, c, t, checksum, o:"apptokens"}
     → decrypt ``et`` (AES-GCM with ``sk``) → authToken for com.apple.gs.xcode.auth.
"""

import base64
import hashlib
import hmac
import plistlib
import struct
from dataclasses import dataclass, field

import requests
import srp._pysrp as srp
from cryptography.hazmat.primitives import padding as _padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# Apple-flavoured SRP: RFC5054 2048-bit group, SHA-256, username out of x.
srp.rfc5054_enable()
srp.no_username_in_x()

GSA_URL = "https://gsa.apple.com/grandslam/GsService2"
VERIFY_TRUSTED_URL = "https://gsa.apple.com/auth/verify/trusteddevice"
VALIDATE_URL = "https://gsa.apple.com/grandslam/GsService2/validate"
XCODE_APP = "com.apple.gs.xcode.auth"

CLIENT_INFO = (
    "<MacBookPro18,3> <Mac OS X;13.4.1;22F8> "
    "<com.apple.AOSKit/282 (com.apple.dt.Xcode/3594.4.19)>"
)
USER_AGENT = "akd/1.0 CFNetwork/978.0.7 Darwin/18.7.0"

_PLIST_HEADER = (
    b"<?xml version='1.0' encoding='UTF-8'?>\n"
    b"<!DOCTYPE plist PUBLIC '-//Apple//DTD PLIST 1.0//EN' "
    b"'http://www.apple.com/DTDs/PropertyList-1.0.dtd'>\n"
)


class AuthError(RuntimeError):
    pass


class NeedsTwoFactor(AuthError):
    pass


@dataclass
class Session:
    dsid: str
    auth_token: str
    anisette: dict = field(default_factory=dict)


def _cpd(anisette: dict) -> dict:
    cpd = {
        "bootstrap": True,
        "icscrec": True,
        "loc": anisette.get("loc", "en_US"),
        "pbe": False,
        "prkgen": True,
        "svct": "iCloud",
    }
    # Apple's clients put the anisette headers inside cpd as well.
    for key in (
        "X-Apple-I-Client-Time",
        "X-Apple-Locale",
        "X-Apple-I-TimeZone",
        "X-Apple-I-MD",
        "X-Apple-I-MD-LU",
        "X-Apple-I-MD-M",
        "X-Apple-I-MD-RINFO",
        "X-Mme-Device-Id",
        "X-Apple-I-SRL-NO",
    ):
        if key in anisette:
            cpd[key] = anisette[key]
    return cpd


def _gsa_request(params: dict, anisette: dict) -> dict:
    body = {"Header": {"Version": "1.0.1"}, "Request": dict(params, cpd=_cpd(anisette))}
    r = requests.post(
        GSA_URL,
        data=plistlib.dumps(body),
        headers={
            "Content-Type": "text/x-xml-plist",
            "Accept": "*/*",
            "User-Agent": USER_AGENT,
            "X-MMe-Client-Info": CLIENT_INFO,
        },
        timeout=30,
    )
    resp = plistlib.loads(r.content)["Response"]
    status = resp.get("Status", {})
    ec = int(status.get("ec", 0))
    if ec != 0:
        msg = status.get("em", "unknown error")
        if ec == -22406:
            raise AuthError("Apple ID or password is incorrect (-22406).")
        raise AuthError(f"GSA error {ec}: {msg}")
    return resp


def _encrypt_password(password: str, salt: bytes, iterations: int, protocol: str) -> bytes:
    digest = hashlib.sha256(password.encode("utf-8")).digest()
    if protocol == "s2k_fo":
        digest = digest.hex().encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", digest, salt, iterations, 32)


def _session_key(usr: srp.User, name: str) -> bytes:
    k = usr.get_session_key()
    if k is None:
        raise AuthError("No SRP session key")
    return hmac.new(k, name.encode(), hashlib.sha256).digest()


def _decrypt_cbc(usr: srp.User, data: bytes) -> bytes:
    key = _session_key(usr, "extra data key:")
    iv = _session_key(usr, "extra data iv:")[:16]
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    plain = dec.update(data) + dec.finalize()
    unpad = _padding.PKCS7(128).unpadder()
    return unpad.update(plain) + unpad.finalize()


def _decrypt_gcm(key: bytes, data: bytes) -> bytes:
    # XYZ || 16-byte IV || ciphertext || 16-byte tag
    if len(data) < 35 or data[:3] != b"XYZ":
        raise AuthError("Bad apptoken blob")
    dec = Cipher(algorithms.AES(key), modes.GCM(data[3:19], data[-16:])).decryptor()
    dec.authenticate_additional_data(b"XYZ")
    return dec.update(data[19:-16]) + dec.finalize()


def _digest_update_str(h: "hashlib._Hash", s: str) -> None:
    h.update(s.encode("utf-8"))


def _digest_update_data(h: "hashlib._Hash", data: bytes) -> None:
    h.update(struct.pack("<I", len(data)))
    h.update(data)


def _verify_np(usr: srp.User, sp: str, spd: bytes, sc: bytes | None, np_: bytes) -> bool:
    """The np check from AltSign: proves the server ran the same negotiation."""
    h = hashlib.sha256()
    _digest_update_str(h, "s2k")
    _digest_update_str(h, ",")
    _digest_update_str(h, "s2k_fo")
    _digest_update_str(h, "|")
    _digest_update_str(h, "|")
    if sp:
        _digest_update_str(h, sp)
    _digest_update_str(h, "|")
    if spd:
        _digest_update_data(h, spd)
    _digest_update_str(h, "|")
    if sc:
        _digest_update_data(h, sc)
    _digest_update_str(h, "|")
    expected = hmac.new(
        _session_key(usr, "HMAC key:"), h.digest(), hashlib.sha256
    ).digest()
    return hmac.compare_digest(expected, np_)


def _xcode_headers(anisette: dict, identity_token: str | None = None) -> dict:
    headers = {
        "Content-Type": "text/x-xml-plist",
        "User-Agent": "Xcode",
        "Accept": "text/x-xml-plist",
        "Accept-Language": "en-us",
        "X-Apple-App-Info": XCODE_APP,
        "X-Xcode-Version": "11.2 (11B41)",
        "X-Mme-Device-Id": anisette.get("X-Mme-Device-Id", ""),
        "X-MMe-Client-Info": CLIENT_INFO,
        "X-Apple-I-MD-M": anisette.get("X-Apple-I-MD-M", ""),
        "X-Apple-I-MD": anisette.get("X-Apple-I-MD", ""),
        "X-Apple-I-MD-LU": anisette.get("X-Apple-I-MD-LU", ""),
        "X-Apple-I-MD-RINFO": anisette.get("X-Apple-I-MD-RINFO", "17106176"),
        "X-Apple-I-Client-Time": anisette.get("X-Apple-I-Client-Time", ""),
        "X-Apple-Locale": anisette.get("X-Apple-Locale", "en_US"),
        "X-Apple-I-Locale": anisette.get("X-Apple-Locale", "en_US"),
        "X-Apple-I-TimeZone": anisette.get("X-Apple-I-TimeZone", "UTC"),
    }
    if identity_token:
        headers["X-Apple-Identity-Token"] = identity_token
    return headers


def _two_factor(dsid: str, idms_token: str, anisette: dict, prompt) -> None:
    """Trusted-device 2FA: trigger the prompt, then validate the typed code."""
    identity_token = base64.b64encode(f"{dsid}:{idms_token}".encode()).decode()
    headers = _xcode_headers(anisette, identity_token)
    # Triggers the code prompt on the user's trusted devices.
    requests.get(VERIFY_TRUSTED_URL, headers=headers, timeout=30)
    code = prompt(
        "A verification code was sent to your trusted Apple devices.\n"
        "Enter the 6-digit code: "
    )
    if not code:
        raise NeedsTwoFactor("No verification code entered.")
    headers["security-code"] = code.strip()
    r = requests.get(VALIDATE_URL, headers=headers, timeout=30)
    resp = plistlib.loads(r.content)
    ec = int(resp.get("ec", 0))
    if ec == -21669:
        raise NeedsTwoFactor("Verification code was incorrect.")
    if ec != 0:
        raise AuthError(f"2FA validation failed: {resp.get('em')} ({ec})")


def authenticate(
    apple_id: str,
    password: str,
    anisette: dict,
    twofa_prompt=None,
) -> Session:
    """Full GSA login. ``twofa_prompt(message) -> str`` is called for the 2FA code."""
    usr = srp.User(apple_id, bytes(), hash_alg=srp.SHA256, ng_type=srp.NG_2048)
    _, A = usr.start_authentication()

    resp = _gsa_request(
        {"A2k": A, "ps": ["s2k", "s2k_fo"], "u": apple_id, "o": "init"}, anisette
    )

    sp = resp.get("sp")
    if sp not in ("s2k", "s2k_fo"):
        raise AuthError(f"Unsupported password protocol {sp!r}")
    c, salt, iters, B = resp["c"], resp["s"], resp["i"], resp["B"]

    # SRP library can't see the password until we learn the salt — patch it in.
    usr.p = _encrypt_password(password, salt, int(iters), sp)
    M1 = usr.process_challenge(salt, B)
    if M1 is None:
        raise AuthError("SRP challenge failed")

    resp = _gsa_request(
        {"c": c, "M1": M1, "u": apple_id, "o": "complete"}, anisette
    )

    M2 = resp.get("M2")
    if M2 is None or not usr.verify_session(M2):
        raise AuthError("Failed to verify the server's SRP proof")

    spd_blob = resp.get("spd")
    sc_blob = resp.get("sc")
    np_ = resp.get("np")
    if np_ is None or not _verify_np(usr, sp, spd_blob or b"", sc_blob, np_):
        raise AuthError("Server negotiation check failed")

    spd = plistlib.loads(_PLIST_HEADER + _decrypt_cbc(usr, spd_blob))
    adsid, idms_token = spd.get("adsid"), spd.get("GsIdmsToken")
    if not adsid or not idms_token:
        raise AuthError("Login response missing adsid/GsIdmsToken")

    status = resp.get("Status", {})
    if status.get("au") in ("trustedDeviceSecondaryAuth", "secondaryAuth"):
        if twofa_prompt is None:
            raise NeedsTwoFactor("Account requires two-factor authentication.")
        _two_factor(adsid, idms_token, anisette, twofa_prompt)
        # Trusted now — run the whole login again.
        return authenticate(apple_id, password, anisette, twofa_prompt)
    if "au" in status:
        raise AuthError(f"Unhandled auth type {status['au']!r}")

    sk = spd.get("sk")
    c2 = spd.get("c")
    if not sk or not c2:
        raise AuthError("Login response missing sk/c")

    # Exchange for the Xcode app token (authToken for provisioning calls).
    checksum = hmac.new(
        sk, b"apptokens" + adsid.encode() + XCODE_APP.encode(), hashlib.sha256
    ).digest()
    resp = _gsa_request(
        {
            "u": adsid,
            "app": [XCODE_APP],
            "c": c2,
            "t": idms_token,
            "checksum": checksum,
            "o": "apptokens",
        },
        anisette,
    )
    et = resp.get("et")
    if et is None:
        raise AuthError("No apptokens blob in response")
    tokens = plistlib.loads(_PLIST_HEADER + _decrypt_gcm(sk, et))
    token = tokens.get("t", {}).get(XCODE_APP, {}).get("token")
    if not token:
        raise AuthError("No Xcode app token in apptokens response")

    return Session(dsid=adsid, auth_token=token, anisette=anisette)
