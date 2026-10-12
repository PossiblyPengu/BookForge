import UIKit

extension BookMaster {
    private static let sentKey = "bm-covers-sent"

    /// Send the jackets of the library's books that are pinned to a shelf row, once each, so BookMaster's
    /// shelf shows the cover of the copy read here. BookMaster keeps its own art where it has better.
    func pushCovers(from library: LibraryStore) async {
        guard isLinked, syncEnabled else { return }
        var sent = Set(UserDefaults.standard.stringArray(forKey: Self.sentKey) ?? [])
        for book in library.books where book.bookmasterId != nil && !sent.contains(book.id.uuidString) {
            guard !Task.isCancelled, isLinked else { return }
            guard let image = library.cover(for: book), let jpeg = Self.thumbnail(image) else { continue }
            if await pushCover(ref: book.bookMasterRef, jpeg: jpeg) {
                sent.insert(book.id.uuidString)
                UserDefaults.standard.set(Array(sent), forKey: Self.sentKey)
            }
        }
    }

    /// Small enough to send: 400 points on the long side, as a JPEG.
    private static func thumbnail(_ image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let scale = min(1, 400 / longest)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return resized.jpegData(compressionQuality: 0.8)
    }
}
