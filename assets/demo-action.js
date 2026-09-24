(() => {
  if (document.getElementById("community-action")) return;
  const link = document.createElement("a");
  link.id = "community-action";
  link.href = "community.html";
  link.textContent = "Map my community ↗";
  const style = document.createElement("style");
  style.textContent =
    'body:has(#card[style*="block"]) #community-action{visibility:hidden}#community-action{position:fixed;z-index:10;bottom:82px;right:24px;padding:10px 14px;border:1px solid #3A4258;border-radius:10px;background:#0F131C;color:#E9E6DF;text-decoration:none;font:13px NS,system-ui,sans-serif}#community-action:focus-visible{outline:2px solid #E9B65A;outline-offset:3px}@media(max-width:760px){body:has(#stage) #community-action{bottom:130px;right:16px;font-size:12px;padding:8px 10px}}';
  document.head.append(style);
  document.body.append(link);
})();
