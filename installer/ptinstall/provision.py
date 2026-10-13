"""Provisioning calls to developerservices2.apple.com — the same endpoints
Xcode hits for a personal team, ported from AltSign's ALTAppleAPI.

Every request is a plist POST to
``https://developerservices2.apple.com/services/QH65B2/<action>?clientId=XABBG36SBA``
carrying the Xcode headers, the session's anisette set, ``X-Apple-I-Identity-Id``
and ``X-Apple-GS-Token``.
"""

import base64
import plistlib
import socket
import uuid
from dataclasses import dataclass

import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from . import config
from .gsa import Session, _xcode_headers

BASE = "https://developerservices2.apple.com/services/QH65B2/"
CLIENT_ID = "XABBG36SBA"
PROTOCOL_VERSION = "QH65B2"


class ProvisionError(RuntimeError):
    def __init__(self, message: str, result_code: int | None = None):
        super().__init__(message)
        self.result_code = result_code


@dataclass
class CertBundle:
    """Everything needed to sign: p12 bytes, private key PEM, cert PEM, profile."""
    p12: bytes
    profile: bytes
    team_id: str
    app_id_id: str
    bundle_id: str


def _post(action: str, session: Session, params: dict | None = None,
          team_id: str | None = None) -> dict:
    body = {
        "clientId": CLIENT_ID,
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": str(uuid.uuid4()).upper(),
    }
    if team_id:
        body["teamId"] = team_id
    if params:
        body.update(params)

    headers = _xcode_headers(session.anisette)
    headers["X-Apple-I-Identity-Id"] = session.dsid
    headers["X-Apple-GS-Token"] = session.auth_token

    url = f"{BASE}{action}?clientId={CLIENT_ID}"
    r = requests.post(
        url,
        data=plistlib.dumps(body),
        headers=headers,
        timeout=30,
        verify=str(config.ca_bundle()),
    )
    try:
        resp = plistlib.loads(r.content)
    except plistlib.InvalidFileException:
        raise ProvisionError(
            f"{action}: HTTP {r.status_code} with a non-plist body: "
            f"{r.text[:120]!r}"
        )
    code = int(resp.get("resultCode", 0))
    if code != 0:
        user_string = resp.get("userString") or resp.get("resultString") or "unknown error"
        raise ProvisionError(f"{action}: {user_string} (resultCode {code})", code)
    return resp


def view_developer(session: Session) -> dict:
    return _post("viewDeveloper.action", session)["developer"]


def list_teams(session: Session) -> list:
    return _post("listTeams.action", session).get("teams", [])


def pick_team(session: Session) -> dict:
    """Prefer the free personal team; fall back to the first active team."""
    teams = list_teams(session)
    if not teams:
        raise ProvisionError("Apple ID has no developer teams — it may not be a "
                             "developer account at all.")
    for t in teams:
        if t.get("type") == "Individual" or "Personal" in t.get("name", ""):
            return t
    return teams[0]


def list_devices(session: Session, team_id: str) -> list:
    return _post("ios/listDevices.action", session, team_id=team_id).get("devices", [])


def register_device(session: Session, team_id: str, udid: str, name: str) -> None:
    try:
        _post("ios/addDevice.action", session,
              {"deviceNumber": udid, "name": name}, team_id=team_id)
    except ProvisionError as e:
        # resultCode 35 with "already exists" is fine — the device is covered.
        if e.result_code == 35 and "already exists" in str(e).lower():
            return
        raise


def device_registered(session: Session, team_id: str, udid: str) -> bool:
    return any(d.get("deviceId") == udid for d in list_devices(session, team_id))


def list_app_ids(session: Session, team_id: str) -> list:
    return _post("ios/listAppIds.action", session, team_id=team_id).get("appIds", [])


def add_app_id(session: Session, team_id: str, bundle_id: str, name: str) -> dict:
    sanitized = "".join(ch for ch in name if ch.isalnum() or ch == " ")
    return _post("ios/addAppId.action", session,
                 {"identifier": bundle_id, "name": sanitized},
                 team_id=team_id)["appId"]


def ensure_app_id(session: Session, team_id: str, bundle_id: str,
                  name: str) -> dict:
    for app in list_app_ids(session, team_id):
        if app.get("identifier") == bundle_id:
            return app
    return add_app_id(session, team_id, bundle_id, name)


def submit_csr(session: Session, team_id: str, csr_pem: str) -> dict:
    return _post("ios/submitDevelopmentCSR.action", session,
                 {"csrContent": csr_pem,
                  "machineId": str(uuid.uuid4()).upper(),
                  "machineName": socket.gethostname()},
                 team_id=team_id)["certRequest"]


def download_profile(session: Session, team_id: str, app_id_id: str) -> bytes:
    resp = _post("ios/downloadTeamProvisioningProfile.action", session,
                 {"appIdId": app_id_id}, team_id=team_id)
    profile = resp.get("provisioningProfile", {})
    encoded = profile.get("encodedProfile")
    if not encoded:
        raise ProvisionError("No provisioning profile in response")
    return base64.b64decode(encoded) if isinstance(encoded, str) else encoded


def _generate_csr() -> tuple:
    """(private_key, csr_pem) — RSA-2048, matching AltSign's request shape."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([
            x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
            x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "CA"),
            x509.NameAttribute(NameOID.LOCALITY_NAME, "Los Angeles"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "ptinstall"),
            x509.NameAttribute(NameOID.COMMON_NAME, "ptinstall"),
        ]))
        .sign(key, hashes.SHA256())
    )
    return key, csr.public_bytes(serialization.Encoding.PEM).decode("utf-8")


def fetch_cert(session: Session, team_id: str, app_id_id: str) -> CertBundle:
    """Fresh CSR → development cert → profile → (p12, mobileprovision)."""
    key, csr_pem = _generate_csr()
    cert_request = submit_csr(session, team_id, csr_pem)
    cert_der = cert_request.get("certContent")
    if cert_der is None:
        encoded = cert_request.get("certificateContent")
        if encoded:
            cert_der = base64.b64decode(encoded)
    if cert_der is None:
        raise ProvisionError("No certificate content in CSR response")
    if isinstance(cert_der, str):
        cert_der = base64.b64decode(cert_der)

    cert = x509.load_der_x509_certificate(cert_der)
    p12 = pkcs12.serialize_key_and_certificates(
        name=b"ptinstall",
        key=key,
        cert=cert,
        cas=None,
        encryption_algorithm=serialization.PrivateFormat.PKCS12.encryption_builder()
        .kdf_rounds(1)
        .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
        .hmac_hash(hashes.SHA1())
        .build(b""),
    )
    profile = download_profile(session, team_id, app_id_id)
    return CertBundle(
        p12=p12,
        profile=profile,
        team_id=team_id,
        app_id_id=app_id_id,
        bundle_id="",
    )
