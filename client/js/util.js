// js/util.js — pure helpers: labels, escaping, time formatting, bias math.
function persistSet(key, set) { localStorage.setItem(key, JSON.stringify([...set])); }

const GEO_FLAGS = { us: "🇺🇸", uk: "🇬🇧", ukraine: "🇺🇦", world: "🌐", canada: "🇨🇦", eu: "🇪🇺", africa: "🦁", australia: "🇦🇺", latam: "🦜", meast: "🕌" };
const GEO_LABELS = { us: "US", uk: "UK", ukraine: "Ukraine", world: "World", canada: "Canada", eu: "EU", africa: "Africa", australia: "Australia", latam: "Latin America", meast: "Middle East" };
const TOPIC_EMOJIS = { Politics: "🏛️", War: "⚔️", Economy: "💰", Tech: "💻", Health: "🏥", Climate: "🌍", Science: "🔬", Crime: "🚨", General: "📰" };
function topicLabel(t) { return (TOPIC_EMOJIS[t] || "") + " " + t; }
function geoLabel(code) {
  return (GEO_FLAGS[code] || "📍") + " " + (GEO_LABELS[code] || code);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function biasClass(bias) {
  if (bias === null) return "c";
  if (bias <= -1) return "l";
  if (bias >= 1) return "r";
  return "c";
}

function dominantBias(s) {
  if (!s.ratedCount) return null;
  if (s.left >= s.center && s.left >= s.right) return "left";
  if (s.right >= s.center && s.right >= s.left) return "right";
  return "center";
}

function passesBias(s) {
  const d = dominantBias(s);
  if (d === null) return true;
  return filters.biases.has(d);
}

function passesUnread(s) {
  return !unreadOnly || !readSet.has(s.clusterId);
}
