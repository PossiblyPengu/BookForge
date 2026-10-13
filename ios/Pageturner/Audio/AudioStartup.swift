import Foundation

@MainActor
final class AudioStartup {
    private var task: Task<Void, Never>?

    func start<Position>(locate: @escaping @MainActor () async -> Position,
                         play: @escaping @MainActor (Position) -> Void) {
        cancel()
        task = Task { @MainActor in
            let position = await locate()
            guard !Task.isCancelled else { return }
            play(position)
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}
