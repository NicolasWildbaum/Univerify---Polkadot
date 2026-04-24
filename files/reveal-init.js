function renderMermaidBlocks(scope = document) {
  const blocks = scope.querySelectorAll("pre code.language-mermaid");

  for (const block of blocks) {
    const pre = block.closest("pre");
    if (!pre || pre.dataset.mermaidRendered === "true") {
      continue;
    }

    const container = document.createElement("div");
    container.className = "mermaid";
    container.textContent = block.textContent ?? "";
    pre.replaceWith(container);
  }

  if (window.mermaid) {
    window.mermaid.run({
      querySelector: ".mermaid"
    });
  }
}

const deck = new Reveal({
  hash: true,
  slideNumber: "c/t",
  controls: true,
  progress: true,
  center: false,
  transition: "fade",
  backgroundTransition: "fade",
  width: 1400,
  height: 900,
  margin: 0.06,
  plugins: [RevealMarkdown, RevealHighlight, RevealNotes]
});

if (window.mermaid) {
  window.mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    fontFamily: "Inter, Avenir Next, Segoe UI, sans-serif",
    themeVariables: {
      background: "#0f1623",
      primaryColor: "#18212f",
      primaryTextColor: "#dde4ef",
      primaryBorderColor: "#09c2b8",
      lineColor: "#64748b",
      secondaryColor: "#0f1623",
      tertiaryColor: "#18212f",
      clusterBkg: "#0f1623",
      clusterBorder: "rgba(255,255,255,0.08)",
      titleColor: "#dde4ef",
      edgeLabelBackground: "#0f1623",
      nodeTextColor: "#dde4ef",
      actorBkg: "#18212f",
      actorBorder: "#09c2b8",
      actorTextColor: "#dde4ef",
      actorLineColor: "#64748b",
      signalColor: "#dde4ef",
      signalTextColor: "#dde4ef",
      labelBoxBkgColor: "#0f1623",
      labelBoxBorderColor: "#09c2b8",
      labelTextColor: "#dde4ef",
      loopTextColor: "#dde4ef",
      noteBorderColor: "#e6007a",
      noteBkgColor: "rgba(230,0,122,0.15)",
      noteTextColor: "#dde4ef",
      activationBorderColor: "#e6007a",
      activationBkgColor: "rgba(230,0,122,0.12)",
      stateBkg: "#18212f",
      stateBorder: "#09c2b8",
      fillType0: "#18212f",
      fillType1: "#0f1623"
    }
  });
}

deck.initialize().then(() => {
  renderMermaidBlocks();

  deck.on("slidechanged", (event) => {
    renderMermaidBlocks(event.currentSlide);
  });
});
