/**
 * Docs page: language toggle + remember preference.
 */
const KEY = "memdash:lang";
const buttons = document.querySelectorAll(".lang-toggle button");
const articles = document.querySelectorAll("main.docs article.lang");

function setLang(lang) {
  for (const btn of buttons) {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  }
  for (const art of articles) {
    art.hidden = !art.classList.contains(`lang-${lang}`);
  }
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // sessionStorage may be unavailable in some browsers/contexts
  }
}

const saved = (() => {
  try { return localStorage.getItem(KEY); } catch { return null; }
})();
if (saved) setLang(saved);

for (const btn of buttons) {
  btn.addEventListener("click", () => setLang(btn.dataset.lang));
}
