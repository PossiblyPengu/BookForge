/**
 * metadata.js
 *
 * ID3 tag reading and audio metadata extraction using jsmediatags.
 * Dynamically loads the jsmediatags library on first use.
 */

const readID3 = (file) =>
  new Promise((resolve) => {
    if (!window.jsmediatags) {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.7/jsmediatags.min.js";
      script.onload = () => parseTag(file, resolve);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    } else {
      parseTag(file, resolve);
    }
  });

const parseTag = (file, resolve) => {
  window.jsmediatags.read(file, {
    onSuccess: (tag) => {
      const t = tag.tags || {};
      let picture = null;
      if (t.picture) {
        const { data, format } = t.picture;
        const bytes = new Uint8Array(data);
        picture = new Blob([bytes], { type: format });
      }
      const normalizeComment = (entry) => {
        if (!entry) return null;
        if (Array.isArray(entry)) {
          for (const item of entry) {
            const text = normalizeComment(item);
            if (text) return text;
          }
          return null;
        }
        if (typeof entry === "string") return entry.trim();
        if (typeof entry === "object") {
          if (typeof entry.text === "string") return entry.text.trim();
          if (typeof entry.description === "string") return entry.description.trim();
          if (entry.data && typeof entry.data === "string") return entry.data.trim();
        }
        return null;
      };
      const comment = normalizeComment(t.comment) || normalizeComment(t.COMM) || normalizeComment(t.comments);
      resolve({
        title: t.title || null,
        artist: t.artist || null,
        album: t.album || null,
        year: t.year || null,
        track: t.track ? String(t.track) : null,
        genre: t.genre || null,
        comment,
        picture,
      });
    },
    onError: () => resolve(null),
  });
};

const readAudioInfo = (file) =>
  new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = "metadata";
    const url = URL.createObjectURL(file);
    audio.src = url;
    audio.addEventListener(
      "loadedmetadata",
      () => {
        const duration = audio.duration || 0;
        const bitrate =
          duration > 0 ? Math.round((file.size * 8) / duration / 1000) : 0;
        URL.revokeObjectURL(url);
        resolve({ duration: Math.round(duration * 100) / 100, bitrate });
      },
      { once: true }
    );
    audio.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(url);
        resolve({ duration: 0, bitrate: 0 });
      },
      { once: true }
    );
  });

/**
 * Extract both ID3 tags and audio info (duration, bitrate) from an MP3 file.
 * @param {File} file
 * @returns {Promise<{title, artist, album, year, track, genre, description, picture, duration, bitrate}>}
 */
export const extractMetadata = async (file) => {
  const [id3, audioInfo] = await Promise.all([
    readID3(file),
    readAudioInfo(file),
  ]);
  return {
    title: id3?.title || null,
    artist: id3?.artist || null,
    album: id3?.album || null,
    year: id3?.year || null,
    track: id3?.track || null,
    genre: id3?.genre || null,
    description: id3?.comment || null,
    picture: id3?.picture || null,
    duration: audioInfo.duration,
    bitrate: audioInfo.bitrate,
  };
};
