const PREVIEW_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
]);

function previewExtension(file) {
  const name = String(file?.filename || file?.path || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function isPreviewVideo(file) {
  return PREVIEW_VIDEO_EXTENSIONS.has(previewExtension(file));
}

function mediaUrl(file) {
  return `/media?path=${encodeURIComponent(file.path)}`;
}

function applyPreviewRatio(frame, width, height) {
  if (!width || !height) return;
  const ratio = width / height;
  frame.style.aspectRatio = `${width} / ${height}`;
  frame.classList.toggle("is-portrait", ratio < 0.92);
}

function attachAdaptiveRatio(frame, media, file) {
  applyPreviewRatio(frame, Number(file?.width), Number(file?.height));
  if (media.tagName === "IMG") {
    const update = () =>
      applyPreviewRatio(frame, media.naturalWidth, media.naturalHeight);
    media.addEventListener("load", update, { once: true });
    if (media.complete) update();
    return;
  }
  media.addEventListener(
    "loadedmetadata",
    () => {
      applyPreviewRatio(frame, media.videoWidth, media.videoHeight);
      if (media.duration && media.currentTime === 0) {
        try {
          media.currentTime = Math.min(0.05, media.duration / 2);
        } catch {}
      }
    },
    { once: true },
  );
}

function createAdaptiveMedia(frame, file, options = {}) {
  frame.replaceChildren();
  frame.classList.remove("is-empty", "is-portrait");
  frame.style.aspectRatio = "";
  if (!file?.path) {
    frame.classList.add("is-empty");
    frame.textContent = "未关联素材";
    return null;
  }
  const media = document.createElement(isPreviewVideo(file) ? "video" : "img");
  media.src = mediaUrl(file);
  if (media.tagName === "VIDEO") {
    media.preload = options.full ? "auto" : "metadata";
    media.muted = !options.full;
    media.playsInline = true;
    if (options.full) media.controls = true;
  } else {
    media.loading = options.full ? "eager" : "lazy";
    media.alt = file.filename || "素材预览";
  }
  media.className = options.full ? "preview-modal-media" : "";
  frame.append(media);
  attachAdaptiveRatio(frame, media, file);
  return media;
}

function showAdaptivePreview(file, label) {
  const layer = document.querySelector("#modal-layer");
  layer.innerHTML = `
    <div class="modal-bg">
      <div class="modal preview-modal">
        <button class="close">×</button>
        <h2>${esc(label || file.filename || "素材预览")}</h2>
        <div class="preview-modal-frame"></div>
        <p>${esc(file.path)}</p>
      </div>
    </div>`;
  const frame = layer.querySelector(".preview-modal-frame");
  const media = createAdaptiveMedia(frame, file, { full: true });
  if (media?.tagName === "VIDEO") media.autoplay = true;
  const close = () => {
    if (media?.tagName === "VIDEO") media.pause();
    layer.innerHTML = "";
  };
  layer.querySelector(".close").onclick = close;
  layer.querySelector(".modal-bg").onclick = (event) => {
    if (event.target === event.currentTarget) close();
  };
}

function loadCandidatePreview(wrapper) {
  const frame = wrapper.querySelector(".candidate-preview-frame");
  const file = wrapper.previewFile;
  if (wrapper.loadedPreviewId === file?.id) return;
  wrapper.loadedPreviewId = file?.id || "";
  createAdaptiveMedia(frame, file);
}

const candidatePreviewObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      loadCandidatePreview(entry.target);
      candidatePreviewObserver.unobserve(entry.target);
    });
  },
  { rootMargin: "280px 0px" },
);

function renderCandidateSlotPreview(slot, file) {
  let wrapper = slot.querySelector(".candidate-preview");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.className = "candidate-preview";
    wrapper.innerHTML = `
      <div class="candidate-preview-frame"></div>
      <small class="candidate-preview-name"></small>
      <button type="button" class="candidate-preview-open">放大预览</button>`;
    slot.append(wrapper);
  }
  const frame = wrapper.querySelector(".candidate-preview-frame");
  const name = wrapper.querySelector(".candidate-preview-name");
  const button = wrapper.querySelector(".candidate-preview-open");
  wrapper.previewFile = file;
  wrapper.loadedPreviewId = null;
  frame.replaceChildren();
  frame.classList.add("is-empty");
  frame.textContent = file ? "滚动到此处加载预览" : "未关联素材";
  name.textContent = file?.filename || "尚未选择文件";
  name.title = file?.filename || "";
  button.hidden = !file;
  button.onclick = file
    ? () =>
        showAdaptivePreview(
          file,
          slot.querySelector("strong")?.textContent || "素材预览",
        )
    : null;
  candidatePreviewObserver.unobserve(wrapper);
  if (file) candidatePreviewObserver.observe(wrapper);
}

function enhanceCandidatePreviews() {
  document.querySelectorAll(".candidate").forEach((article) => {
    const candidate = candidates[Number(article.dataset.index)];
    if (!candidate) return;
    article.querySelectorAll(".slot").forEach((slot) => {
      const select = slot.querySelector("[data-slot]");
      if (!select) return;
      const update = () => {
        const file = candidate.files.find((item) => item.id === select.value);
        renderCandidateSlotPreview(slot, file);
      };
      if (!select.dataset.previewBound) {
        select.dataset.previewBound = "true";
        select.addEventListener("change", update);
        update();
      }
    });
  });
}

function enhanceAssetPreviews() {
  document.querySelectorAll(".asset-preview").forEach((frame) => {
    const media = frame.querySelector("img,video");
    if (!media || media.dataset.adaptiveBound) return;
    media.dataset.adaptiveBound = "true";
    attachAdaptiveRatio(frame, media, {});
  });
}

previewAsset = function previewAssetEnhanced(asset, slot) {
  showAdaptivePreview(asset, SLOT_LABELS[slot] || asset.filename);
};

const previewObserver = new MutationObserver(() => {
  enhanceAssetPreviews();
  enhanceCandidatePreviews();
});

previewObserver.observe(document.body, { childList: true, subtree: true });
enhanceAssetPreviews();
enhanceCandidatePreviews();
