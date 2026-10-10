import Foundation

/// A minimal zip writer: every entry is stored (not compressed), which is all an
/// EPUB needs and keeps the output readable by any zip reader. Pure Foundation,
/// so the converter built on it can be checked on Linux.
struct ZipWriter {
    private var body = Data()
    private var directory = Data()
    private var count = 0

    private static let table: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for byte in data { c = table[Int((c ^ UInt32(byte)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }

    private static func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xFF), UInt8(v >> 8)] }
    private static func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8(v >> 24)]
    }

    /// Add a file. Names are UTF-8; the date is fixed (1980-01-01) so output is reproducible.
    mutating func add(_ name: String, _ content: Data) {
        let nameBytes = Array(name.utf8)
        let crc = Self.crc32(content)
        let size = UInt32(content.count)
        let offset = UInt32(body.count)

        var local: [UInt8] = []
        local += Self.le32(0x0403_4B50)            // local file header
        local += Self.le16(20)                     // version needed
        local += Self.le16(0x0800)                 // flags: UTF-8 names
        local += Self.le16(0)                      // method: stored
        local += Self.le16(0)                      // time
        local += Self.le16(0x0021)                 // date: 1980-01-01
        local += Self.le32(crc)
        local += Self.le32(size)                   // compressed size
        local += Self.le32(size)                   // uncompressed size
        local += Self.le16(UInt16(nameBytes.count))
        local += Self.le16(0)                      // extra field length
        local += nameBytes
        body.append(contentsOf: local)
        body.append(content)

        var central: [UInt8] = []
        central += Self.le32(0x0201_4B50)          // central directory header
        central += Self.le16(20)                   // version made by
        central += Self.le16(20)                   // version needed
        central += Self.le16(0x0800)
        central += Self.le16(0)
        central += Self.le16(0)
        central += Self.le16(0x0021)
        central += Self.le32(crc)
        central += Self.le32(size)
        central += Self.le32(size)
        central += Self.le16(UInt16(nameBytes.count))
        central += Self.le16(0)                    // extra
        central += Self.le16(0)                    // comment
        central += Self.le16(0)                    // disk number
        central += Self.le16(0)                    // internal attributes
        central += Self.le32(0)                    // external attributes
        central += Self.le32(offset)
        central += nameBytes
        directory.append(contentsOf: central)
        count += 1
    }

    mutating func add(_ name: String, text: String) {
        add(name, Data(text.utf8))
    }

    /// The finished archive.
    func finish() -> Data {
        var out = body
        let directoryOffset = UInt32(body.count)
        out.append(directory)
        var end: [UInt8] = []
        end += Self.le32(0x0605_4B50)              // end of central directory
        end += Self.le16(0)
        end += Self.le16(0)
        end += Self.le16(UInt16(count))
        end += Self.le16(UInt16(count))
        end += Self.le32(UInt32(directory.count))
        end += Self.le32(directoryOffset)
        end += Self.le16(0)
        out.append(contentsOf: end)
        return out
    }
}
