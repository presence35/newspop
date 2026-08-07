"""
Tiny local embedding sidecar for GroundZero.

Run this only if you set CLUSTER_MODE=embedding. Otherwise app.js uses its
built-in zero-dependency tfidf clustering and never talks to this port.

Node (app.js) calls it at http://127.0.0.1:5055/embed with a list of
headlines and gets back vectors it uses for cosine-similarity clustering.

Zero external API calls. Model downloads once (~80MB) on first run, then
runs fully offline. No per-request cost, no token billing — it's just
local math, not an LLM call.

pip install sentence-transformers flask
"""

from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer

app = Flask(__name__)

# all-MiniLM-L6-v2: small (80MB), fast on CPU, good enough for
# "is this the same news story" clustering. Not a generative model,
# no reasoning, no tokens-as-cost — just a fixed-size vector per sentence.
model = SentenceTransformer("all-MiniLM-L6-v2")


@app.route("/embed", methods=["POST"])
def embed():
    body = request.get_json(force=True)
    texts = body.get("texts", [])
    if not texts:
        return jsonify({"embeddings": []})
    vectors = model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
    return jsonify({"embeddings": vectors.tolist()})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    # Localhost only — never expose this port publicly.
    app.run(host="127.0.0.1", port=5055)
