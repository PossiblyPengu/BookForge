const form = document.getElementById("compile-form");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const trackList = document.getElementById("track-list");
const clearAllButton = document.getElementById("clear-all");
const compileButton = document.getElementById("compile-button");
const statusValue = document.getElementById("status-value");
const titleInput = form.elements.namedItem("title");
const authorInput = form.elements.namedItem("author");

let tracks = []; // { file, meta: null | {...} }

const updateStatus = (label) => {
  statusValue.textContent = label;
};

const formatDuration = (seconds) => {
  if (!seconds) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const refreshTrackList = () => {
  trackList.innerHTML = "";

  if (!tracks.length) {
    trackList.innerHTML = "<li class=\"empty\">No tracks added yet.</li>";
    compileButton.disabled = true;
    return;
  }

  compileButton.disabled = false;

  tracks.forEach((track, index) => {
    const li = document.createElement("li");
    li.className = "track-row";

    const order = document.createElement("strong");
    order.textContent = String(index + 1).padStart(2, "0");

    const info = document.createElement("div");
    info.className = "track-info";

    const nameEl = document.createElement("span");
    nameEl.className = "track-name";
    const megabytes = (track.file.size / (1024 * 1024)).toFixed(1);
    nameEl.textContent = track.file.name;

    const details = document.createElement("small");
    details.className = "track-meta";
    if (track.meta) {
      const parts = [];
      if (track.meta.title) parts.push(track.meta.title);
      if (track.meta.artist) parts.push(track.meta.artist);
      parts.push(formatDuration(track.meta.duration));
      parts.push(`${track.meta.bitrate || "?"}kbps`);
      parts.push(`${megabytes} MB`);
      details.textContent = parts.join(" · ");
    } else {
      details.textContent = `${megabytes} MB`;
    }

    info.append(nameEl, details);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.className = "ghost icon";
    upButton.textContent = "↑";
    upButton.disabled = index === 0;
    upButton.addEventListener("click", () => moveTrack(index, index - 1));

    const downButton = document.createElement("button");
    downButton.type = "button";
    downButton.className = "ghost icon";
    downButton.textContent = "↓";
    downButton.disabled = index === tracks.length - 1;
    downButton.addEventListener("click", () => moveTrack(index, index + 1));

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost icon";
    removeButton.textContent = "✕";
    removeButton.addEventListener("click", () => removeTrack(index));

    actions.append(upButton, downButton, removeButton);
    li.append(order, info, actions);
    trackList.append(li);
  });
};

const fetchMetadata = async (newTracks) => {
  const metaData = new FormData();
  newTracks.forEach((t) => metaData.append("files", t.file, t.file.name));

  try {
    const resp = await fetch("/api/metadata", { method: "POST", body: metaData });
    if (!resp.ok) return;
    const results = await resp.json();

    results.forEach((meta, i) => {
      newTracks[i].meta = meta;
    });

    // Auto-populate title/author from first track if fields are at defaults
    if (tracks.length && tracks[0].meta) {
      const first = tracks[0].meta;
      if (first.album && titleInput.value === "Untitled Audiobook") {
        titleInput.value = first.album;
      } else if (first.title && titleInput.value === "Untitled Audiobook") {
        titleInput.value = first.title;
      }
      if (first.artist && authorInput.value === "Unknown") {
        authorInput.value = first.artist;
      }
    }

    refreshTrackList();
  } catch (err) {
    console.warn("Metadata fetch failed:", err);
  }
};

const addFiles = (fileList) => {
  const mp3Files = Array.from(fileList).filter((file) =>
    file.type === "audio/mpeg" || file.name.toLowerCase().endsWith(".mp3")
  );

  const newTracks = mp3Files.map((file) => ({ file, meta: null }));
  tracks = [...tracks, ...newTracks];
  refreshTrackList();
  fetchMetadata(newTracks);
};

const moveTrack = (from, to) => {
  if (to < 0 || to >= tracks.length) return;
  const updated = [...tracks];
  const [item] = updated.splice(from, 1);
  updated.splice(to, 0, item);
  tracks = updated;
  refreshTrackList();
};

const removeTrack = (index) => {
  tracks.splice(index, 1);
  refreshTrackList();
};

clearAllButton.addEventListener("click", () => {
  tracks = [];
  titleInput.value = "Untitled Audiobook";
  authorInput.value = "Unknown";
  refreshTrackList();
});

dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragover");
  if (event.dataTransfer?.files?.length) {
    addFiles(event.dataTransfer.files);
  }
});

fileInput.addEventListener("change", (event) => {
  if (event.target.files?.length) {
    addFiles(event.target.files);
    fileInput.value = "";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!tracks.length) {
    updateStatus("Add MP3 files first");
    return;
  }

  updateStatus("Uploading…");
  compileButton.disabled = true;

  const formData = new FormData();
  const titleValue = titleInput.value.trim();
  const authorValue = authorInput.value.trim();

  formData.append("title", titleValue || "Untitled Audiobook");
  formData.append("author", authorValue || "Unknown");

  tracks.forEach((track) => {
    formData.append("files", track.file, track.file.name);
  });

  try {
    const response = await fetch("/api/compile", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(error.detail || "Conversion failed");
    }

    updateStatus("Encoding…");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const filename = filenameMatch ? filenameMatch[1] : "audiobook.m4b";

    const downloadUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(downloadUrl);

    updateStatus("Complete");
  } catch (err) {
    console.error(err);
    updateStatus(err.message || "Failed");
  } finally {
    compileButton.disabled = !tracks.length;
    setTimeout(() => {
      if (!tracks.length) {
        updateStatus("Idle");
      }
    }, 4000);
  }
});

refreshTrackList();
