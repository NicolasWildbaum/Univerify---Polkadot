# Presentation Deck

This directory contains the Reveal.js presentation assets for Univerify. It is separate from the application code and exists as a lightweight way to present the project architecture, flow, and demo material.

## Key Files

| File | Purpose |
| --- | --- |
| [`PRESENTATION.md`](PRESENTATION.md) | Slide content in Markdown |
| [`index.html`](index.html) | Reveal.js container page |
| [`reveal-init.js`](reveal-init.js) | Reveal initialization |
| [`theme-univerify.css`](theme-univerify.css) | Deck-specific styling |
| [`serve.mjs`](serve.mjs) | Small static server with automatic free-port fallback |
| [`package.json`](package.json) | Presentation dependencies and `present` script |

Mermaid diagrams embedded in the Markdown are rendered inside the deck.

## Run

```bash
cd files
npm install
npm run present
```

The server binds to `127.0.0.1` and starts at port `8000`, then walks upward until it finds a free port.

You can suggest a starting port:

```bash
PORT=9123 npm run present
```

## Notes

- The deck uses the repo's Node.js version expectations, so Node `22.x` is the safe default.
- `serve.mjs` is intentionally tiny and serves local static files only; it is not coupled to the frontend Vite app.
