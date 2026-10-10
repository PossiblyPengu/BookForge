#!/usr/bin/env python3
"""epub_check.py FILE — structural checks an EPUB reader relies on.

Not epubcheck, but the rules that make Readium open a book: the container's
mimetype entry (first, stored, exact), a rootfile that exists, an OPF whose
manifest files all exist, a spine of manifest ids, a nav document, and every
XML/XHTML part parsing as strict XML.
"""
import posixpath
import sys
import zipfile
import xml.dom.minidom as minidom

path = sys.argv[1]
errors = []
try:
    z = zipfile.ZipFile(path)
except Exception as e:
    print("FAIL not a zip:", e)
    sys.exit(1)

names = z.namelist()
if not names or names[0] != "mimetype":
    errors.append("first entry is not 'mimetype': %r" % (names[:1],))
else:
    info = z.getinfo("mimetype")
    if info.compress_type != 0:
        errors.append("mimetype is compressed")
    if info.extra:
        errors.append("mimetype has an extra field")
    if z.read("mimetype") != b"application/epub+zip":
        errors.append("mimetype content is wrong")
bad = z.testzip()
if bad:
    errors.append("CRC mismatch in " + bad)

def parse(name):
    try:
        return minidom.parseString(z.read(name))
    except Exception as e:
        errors.append("%s is not well-formed XML: %s" % (name, e))
        return None

opf_path = None
if "META-INF/container.xml" not in names:
    errors.append("no META-INF/container.xml")
else:
    c = parse("META-INF/container.xml")
    if c:
        roots = c.getElementsByTagName("rootfile")
        opf_path = roots[0].getAttribute("full-path") if roots else None
if not opf_path or opf_path not in names:
    errors.append("rootfile %r is missing" % opf_path)

chapters = 0
if opf_path in names:
    opf = parse(opf_path)
    if opf:
        base = posixpath.dirname(opf_path)
        manifest = {}
        nav_href = None
        for item in opf.getElementsByTagName("item"):
            href = posixpath.normpath(posixpath.join(base, item.getAttribute("href")))
            manifest[item.getAttribute("id")] = href
            if href not in names:
                errors.append("manifest file missing: " + href)
            if "nav" in item.getAttribute("properties").split():
                nav_href = href
        for itemref in opf.getElementsByTagName("itemref"):
            if itemref.getAttribute("idref") not in manifest:
                errors.append("spine idref not in manifest: " + itemref.getAttribute("idref"))
            chapters += 1
        for tag in ("dc:identifier", "dc:title", "dc:language"):
            if not opf.getElementsByTagName(tag):
                errors.append("OPF has no " + tag)
        if not nav_href:
            errors.append("no nav document")
        else:
            nav = parse(nav_href)
            if nav and len(nav.getElementsByTagName("a")) != chapters:
                errors.append("nav lists %d entries for %d spine items" % (len(nav.getElementsByTagName("a")), chapters))
        for href in manifest.values():
            if href.endswith(".xhtml") and href in names:
                parse(href)

if errors:
    print("FAIL", "; ".join(errors))
    sys.exit(1)
print("OK", chapters)
