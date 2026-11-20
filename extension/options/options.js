const prefix = document.getElementById("output-prefix");
const autoName = document.getElementById("auto-name");
const saved = document.getElementById("saved");

chrome.storage.local.get(["chatcap_output_prefix", "chatcap_auto_name"]).then((cfg) => {
  prefix.value = cfg.chatcap_output_prefix || "chatcap";
  autoName.checked = cfg.chatcap_auto_name !== false;
});

document.getElementById("save").addEventListener("click", () => {
  chrome.storage.local.set({
    chatcap_output_prefix: prefix.value.trim() || "chatcap",
    chatcap_auto_name: autoName.checked,
  }).then(() => {
    saved.textContent = "Saved.";
    setTimeout(() => { saved.textContent = ""; }, 2000);
  });
});
