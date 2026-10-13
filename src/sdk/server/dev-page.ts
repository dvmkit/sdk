export function devPageHtml(dvmName: string): string {
  const escaped = dvmName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped} — Dev</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; margin-bottom: 1rem; }
  button { padding: 0.5rem 1rem; background: #111; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem; }
  button:disabled { opacity: 0.4; cursor: default; }
  .plain-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .plain-form input { flex: 1; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.875rem; }
  .schema-form { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.5rem; }
  .field-row { display: flex; flex-direction: column; gap: 0.25rem; }
  .field-row > label { font-size: 0.8rem; font-weight: 600; color: #555; }
  .field-row input[type="text"],
  .field-row input[type="url"],
  .field-row select { width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.875rem; }
  .required { color: #dc3545; font-weight: normal; }
  .options-header { font-size: 0.7rem; font-weight: 500; color: #aaa; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 0.5rem; }
  .bool-row { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; }
  .bool-row label { font-size: 0.875rem; display: flex; align-items: center; gap: 0.4rem; cursor: pointer; padding: 0.3rem 0; }
  .schema-form > .field-row input[type="text"] { max-width: 12rem; }
  .toggle-section { border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; }
  .toggle-header { display: flex; align-items: center; gap: 0.5rem; padding: 0.55rem 0.75rem; cursor: pointer; font-size: 0.875rem; font-weight: 500; color: #333; user-select: none; }
  .toggle-header:hover { background: #fafafa; }
  .toggle-header input[type="checkbox"] { margin: 0; }
  .toggle-chevron { margin-left: auto; color: #bbb; font-size: 1rem; transition: transform 0.15s; }
  .toggle-section:not(.collapsed) .toggle-chevron { transform: rotate(90deg); color: #888; }
  .toggle-section.collapsed { border-color: #eee; }
  .toggle-section.collapsed .toggle-content { display: none; }
  .toggle-content { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.625rem 0.75rem; border-top: 1px solid #eee; }
  .checkbox-group { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .checkbox-group label { font-size: 0.875rem; display: flex; align-items: center; gap: 0.35rem; cursor: pointer; }
  .array-items { display: flex; flex-direction: column; gap: 0.35rem; }
  .array-item { display: flex; gap: 0.5rem; align-items: center; }
  .array-item input { flex: 1; padding: 0.4rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.875rem; }
  .add-btn { align-self: flex-start; background: #666; font-size: 0.8rem; padding: 0.3rem 0.6rem; margin-top: 0.25rem; }
  .remove-btn { background: #999; font-size: 0.75rem; padding: 0.2rem 0.45rem; line-height: 1; }
  .form-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 0.25rem; }
  #raw-toggle { font-size: 0.8rem; color: #666; text-decoration: none; }
  #raw-toggle:hover { text-decoration: underline; }
  #raw-json-area { width: 100%; min-height: 200px; font-family: ui-monospace, monospace; font-size: 0.8rem; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; resize: vertical; margin-bottom: 0.5rem; }
  .sub-fields { display: flex; flex-direction: column; gap: 0.5rem; }
  #messages { display: flex; flex-direction: column; gap: 0.5rem; }
  .msg { padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.875rem; line-height: 1.4; }
  .msg-provider { background: #f0f0f0; }
  .msg-system { background: #fff3cd; font-style: italic; }
  .msg-result { background: #d4edda; font-weight: 500; }
  .msg-error { background: #f8d7da; }
  .prompt-form { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .prompt-form input { flex: 1; padding: 0.4rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.875rem; }
  .prompt-options { display: flex; gap: 0.25rem; flex-wrap: wrap; margin-top: 0.5rem; }
  .prompt-options button { background: #555; font-size: 0.8rem; padding: 0.3rem 0.6rem; }
  .target-bar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-size: 0.8rem; color: #888; }
  .target-bar input { flex: 1; padding: 0.3rem 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.8rem; font-family: ui-monospace, monospace; color: #555; background: #fafafa; }
  .target-bar input:focus { outline: none; border-color: #999; background: #fff; color: #1a1a1a; }
  .target-bar .target-label { white-space: nowrap; }
  .capability-bar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-size: 0.8rem; color: #888; }
  .capability-bar label { white-space: nowrap; }
  .capability-bar select { flex: 1; padding: 0.35rem 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.8rem; background: #fafafa; color: #555; }
  pre { white-space: pre-wrap; word-break: break-word; }
  html.dark body { background: #1a1a1a; color: #e0e0e0; }
  html.dark button { background: #e0e0e0; color: #1a1a1a; }
  html.dark .plain-form input,
  html.dark .field-row input[type="text"],
  html.dark .field-row input[type="url"],
  html.dark .field-row select,
  html.dark .array-item input,
  html.dark .prompt-form input,
  html.dark #raw-json-area { background: #2a2a2a; border-color: #444; color: #e0e0e0; }
  html.dark .field-row > label { color: #999; }
  html.dark .options-header { color: #666; }
  html.dark .toggle-section { border-color: #383838; }
  html.dark .toggle-header { color: #ccc; }
  html.dark .toggle-header:hover { background: #252525; }
  html.dark .toggle-chevron { color: #555; }
  html.dark .toggle-section:not(.collapsed) .toggle-chevron { color: #888; }
  html.dark .toggle-section.collapsed { border-color: #333; }
  html.dark .toggle-content { border-top-color: #383838; }
  html.dark .msg-provider { background: #2a2a2a; }
  html.dark .msg-system { background: #3d3520; color: #e0c060; }
  html.dark .msg-result { background: #1e3a25; color: #80d090; }
  html.dark .msg-error { background: #3a1e1e; color: #e08080; }
  html.dark .prompt-options button { background: #555; }
  html.dark .add-btn { background: #555; }
  html.dark .remove-btn { background: #444; }
  html.dark #raw-toggle { color: #888; }
  html.dark .target-bar { color: #666; }
  html.dark .target-bar input { background: #252525; border-color: #444; color: #999; }
  html.dark .target-bar input:focus { border-color: #666; background: #2a2a2a; color: #e0e0e0; }
  html.dark .capability-bar { color: #666; }
  html.dark .capability-bar select { background: #252525; border-color: #444; color: #999; }
  html.dark .required { color: #e06060; }
  html.dark .bool-row label { color: #ccc; }
  html.dark .checkbox-group label { color: #ccc; }
  html.dark #theme-toggle { color: #888; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .page-header h1 { margin-bottom: 0; }
  #theme-toggle { background: none; color: #666; padding: 0.25rem; font-size: 1.1rem; cursor: pointer; line-height: 1; }
  #theme-toggle:hover { opacity: 0.7; }
</style>
<script>
(function() {
  var s = localStorage.getItem("dvmkit-dev-theme");
  var dark = s === "dark" || (s !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
})();
</script>
</head>
<body>
<div class="page-header">
  <h1>${escaped}</h1>
  <button type="button" id="theme-toggle"></button>
</div>
<div class="target-bar">
  <span class="target-label">target</span>
  <input id="target-url" type="url" value="">
</div>
<div id="capability-container"></div>
<div id="form-container">
  <form class="plain-form">
    <input id="job-input" type="text" placeholder="Enter input..." autofocus>
    <button type="submit" id="submit-btn">Submit Job</button>
  </form>
</div>
<div id="messages"></div>

<script>
var messagesEl = document.getElementById("messages");
var container = document.getElementById("form-container");
var capabilityContainer = document.getElementById("capability-container");
var submitBtn = document.getElementById("submit-btn");
var targetInput = document.getElementById("target-url");

var jobId = null;
var jobToken = null;
var lastSeq = 0;
var polling = false;
var currentCapabilities = {};
var currentCapability = null;
var currentSchema = null;
var rawJsonMode = false;

// ── Target URL ──────────────────────────────────────────────────────

var baseUrl = localStorage.getItem("dvmkit-dev-target") || window.location.origin;
targetInput.value = baseUrl;
syncTargetCookie();

targetInput.addEventListener("change", function() {
  var url = targetInput.value.trim().replace(new RegExp("/+$"), "");
  if (!url) url = window.location.origin;
  baseUrl = url;
  localStorage.setItem("dvmkit-dev-target", url);
  syncTargetCookie();
  currentCapabilities = {};
  currentCapability = null;
  currentSchema = null;
  rawJsonMode = false;
  capabilityContainer.innerHTML = "";
  initSchemaForm();
});

function syncTargetCookie() {
  if (baseUrl !== window.location.origin) {
    document.cookie = "dvmkit_target=" + encodeURIComponent(baseUrl) + ";path=/";
  } else {
    document.cookie = "dvmkit_target=;path=/;max-age=0";
  }
}

function api(path) {
  if (baseUrl === window.location.origin) return path;
  return "/_proxy" + path;
}

// ── Submit (event delegation on container) ──────────────────────────

container.addEventListener("submit", function(e) {
  e.preventDefault();
  var input;
  if (currentSchema) {
    if (rawJsonMode) {
      input = document.getElementById("raw-json-area").value.trim();
    } else {
      input = JSON.stringify(buildJsonFromForm(currentSchema));
    }
  } else {
    var el = document.getElementById("job-input");
    input = el ? el.value.trim() : "";
  }
  if (!input) return;

  messagesEl.innerHTML = "";
  submitBtn.disabled = true;
  lastSeq = 0;
  jobId = null;
  jobToken = null;

  fetch(api("/v1/job"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: currentCapability, input: input }),
  })
    .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
    .then(function(r) {
      if (!r.ok) {
        addMsg("Error: " + (r.data.error || JSON.stringify(r.data)), "msg-error");
        submitBtn.disabled = false;
        return;
      }
      jobId = r.data.job_id;
      jobToken = typeof r.data.job_token === "string" ? r.data.job_token : null;
      if (r.data.status === "completed") {
        addMsg("Summary: " + r.data.summary, "msg-result");
        submitBtn.disabled = false;
      } else {
        startPolling();
      }
    })
    .catch(function(err) {
      addMsg("Network error: " + err.message, "msg-error");
      submitBtn.disabled = false;
    });
});

// ── Schema form ─────────────────────────────────────────────────────

function initSchemaForm() {
  fetch(api("/v1/info"))
    .then(function(res) { return res.json(); })
    .then(function(info) {
      currentCapabilities = info.capabilities || {};
      var names = Object.keys(currentCapabilities);
      currentCapability = names.length > 0 ? names[0] : null;
      renderCapabilityPicker(names);
      renderCurrentCapabilityForm();
    })
    .catch(function() {
      currentCapabilities = {};
      currentCapability = null;
      capabilityContainer.innerHTML = "";
      resetToPlainForm();
    });
}

function renderCapabilityPicker(names) {
  capabilityContainer.innerHTML = "";
  if (names.length < 2) return;

  var bar = document.createElement("div");
  bar.className = "capability-bar";
  var label = document.createElement("label");
  label.htmlFor = "capability-select";
  label.textContent = "capability";
  var select = document.createElement("select");
  select.id = "capability-select";
  for (var i = 0; i < names.length; i++) {
    var option = document.createElement("option");
    option.value = names[i];
    option.textContent = names[i];
    select.appendChild(option);
  }
  select.value = currentCapability;
  select.addEventListener("change", function() {
    currentCapability = select.value;
    rawJsonMode = false;
    renderCurrentCapabilityForm();
  });
  bar.appendChild(label);
  bar.appendChild(select);
  capabilityContainer.appendChild(bar);
}

function renderCurrentCapabilityForm() {
  var capability = currentCapability ? currentCapabilities[currentCapability] : null;
  var schema = capability ? capability.input_schema : null;
  if (schema && schema.properties) {
    currentSchema = schema;
    renderSchemaForm(currentSchema);
  } else {
    resetToPlainForm();
  }
}

function resetToPlainForm() {
  currentSchema = null;
  container.innerHTML = '<form class="plain-form">' +
    '<input id="job-input" type="text" placeholder="Enter input..." autofocus>' +
    '<button type="submit" id="submit-btn">Submit Job</button></form>';
  submitBtn = document.getElementById("submit-btn");
}

function renderSchemaForm(schema) {
  container.innerHTML = "";

  var form = document.createElement("form");
  form.className = "schema-form";

  var required = schema.required || [];
  var props = schema.properties || {};
  var names = Object.keys(props);

  var requiredNames = names.filter(function(n) { return required.indexOf(n) !== -1; });
  var optionalNames = names.filter(function(n) { return required.indexOf(n) === -1; });

  // Required fields
  for (var i = 0; i < requiredNames.length; i++) {
    form.appendChild(renderField(requiredNames[i], props[requiredNames[i]], requiredNames[i], true));
  }

  // Optional fields
  if (optionalNames.length > 0) {
    var header = document.createElement("div");
    header.className = "options-header";
    header.textContent = "Options";
    form.appendChild(header);

    var bools = optionalNames.filter(function(n) { return props[n].type === "boolean"; });
    var strings = optionalNames.filter(function(n) { return props[n].type === "string"; });
    var complex = optionalNames.filter(function(n) {
      return props[n].type === "object" || props[n].type === "array";
    });

    if (bools.length > 0) {
      var row = document.createElement("div");
      row.className = "bool-row";
      for (var b = 0; b < bools.length; b++) {
        var lbl = document.createElement("label");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.path = bools[b];
        if (props[bools[b]].default === true) cb.checked = true;
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(" " + formatLabel(bools[b])));
        row.appendChild(lbl);
      }
      form.appendChild(row);
    }

    for (var s = 0; s < strings.length; s++) {
      form.appendChild(renderField(strings[s], props[strings[s]], strings[s], false));
    }

    for (var c = 0; c < complex.length; c++) {
      form.appendChild(renderToggleSection(complex[c], props[complex[c]]));
    }
  }

  // Raw JSON textarea (hidden)
  var rawArea = document.createElement("textarea");
  rawArea.id = "raw-json-area";
  rawArea.style.display = "none";
  form.appendChild(rawArea);

  // Footer
  var footer = document.createElement("div");
  footer.className = "form-footer";

  var rawToggle = document.createElement("a");
  rawToggle.href = "#";
  rawToggle.id = "raw-toggle";
  rawToggle.textContent = "Raw JSON";
  rawToggle.addEventListener("click", function(e) { e.preventDefault(); toggleRawJson(); });
  footer.appendChild(rawToggle);

  var btn = document.createElement("button");
  btn.type = "submit";
  btn.id = "submit-btn";
  btn.textContent = "Submit Job";
  footer.appendChild(btn);

  form.appendChild(footer);
  container.appendChild(form);
  submitBtn = btn;

  // Focus first input
  var first = form.querySelector("input[type=text], input[type=url]");
  if (first) first.focus();
}

function renderField(name, prop, path, isRequired) {
  var row = document.createElement("div");
  row.className = "field-row";

  var label = document.createElement("label");
  label.textContent = formatLabel(name);
  if (isRequired) {
    var star = document.createElement("span");
    star.className = "required";
    star.textContent = " *";
    label.appendChild(star);
  }
  row.appendChild(label);

  if (prop.type === "string" && prop.enum) {
    var select = document.createElement("select");
    select.dataset.path = path;
    if (!isRequired) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Select\u2026";
      select.appendChild(empty);
    }
    for (var i = 0; i < prop.enum.length; i++) {
      var opt = document.createElement("option");
      opt.value = prop.enum[i];
      opt.textContent = prop.enum[i];
      if (prop.default === prop.enum[i]) opt.selected = true;
      select.appendChild(opt);
    }
    row.appendChild(select);
  } else if (prop.type === "string") {
    var input = document.createElement("input");
    input.type = (name === "url" || name.endsWith("_url")) ? "url" : "text";
    input.dataset.path = path;
    input.placeholder = (name === "url" || name.endsWith("_url")) ? "https://\u2026" : "";
    if (prop.default) input.value = prop.default;
    row.appendChild(input);
  } else if (prop.type === "boolean") {
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.path = path;
    if (prop.default === true) cb.checked = true;
    row.appendChild(cb);
  } else if (prop.type === "array") {
    row.appendChild(renderArrayField(prop, path));
  } else if (prop.type === "object" && prop.properties) {
    var sub = document.createElement("div");
    sub.className = "sub-fields";
    var subReq = prop.required || [];
    var subNames = Object.keys(prop.properties);
    for (var j = 0; j < subNames.length; j++) {
      sub.appendChild(renderField(subNames[j], prop.properties[subNames[j]], path + "." + subNames[j], subReq.indexOf(subNames[j]) !== -1));
    }
    row.appendChild(sub);
  }

  return row;
}

function renderToggleSection(name, prop) {
  var section = document.createElement("div");
  section.className = "toggle-section collapsed";

  var header = document.createElement("label");
  header.className = "toggle-header";
  var cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.toggle = name;
  header.appendChild(cb);
  var span = document.createElement("span");
  span.textContent = formatLabel(name);
  header.appendChild(span);
  var chevron = document.createElement("span");
  chevron.className = "toggle-chevron";
  chevron.textContent = "\u203a";
  header.appendChild(chevron);
  section.appendChild(header);

  var content = document.createElement("div");
  content.className = "toggle-content";

  if (prop.type === "object" && prop.properties) {
    var subReq = prop.required || [];
    var subNames = Object.keys(prop.properties);
    for (var i = 0; i < subNames.length; i++) {
      content.appendChild(renderField(
        subNames[i], prop.properties[subNames[i]],
        name + "." + subNames[i],
        subReq.indexOf(subNames[i]) !== -1
      ));
    }
  } else if (prop.type === "array") {
    content.appendChild(renderArrayField(prop, name));
  }

  section.appendChild(content);

  cb.addEventListener("change", function() {
    section.classList.toggle("collapsed", !cb.checked);
    if (cb.checked) {
      var itemsEls = section.querySelectorAll(".array-items");
      for (var j = 0; j < itemsEls.length; j++) {
        if (itemsEls[j].children.length === 0) {
          addArrayItem(itemsEls[j], itemsEls[j].dataset.items);
        }
      }
      var first = content.querySelector("input[type=text], input[type=url], select");
      if (first) first.focus();
    }
  });

  return section;
}

function renderArrayField(prop, path) {
  var wrap = document.createElement("div");
  wrap.className = "array-field";
  var itemSchema = prop.items || {};

  if (itemSchema.enum) {
    var group = document.createElement("div");
    group.className = "checkbox-group";
    var defaults = prop.default || [];
    for (var i = 0; i < itemSchema.enum.length; i++) {
      var lbl = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = itemSchema.enum[i];
      cb.dataset.array = path;
      if (defaults.indexOf(itemSchema.enum[i]) !== -1) cb.checked = true;
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(" " + itemSchema.enum[i]));
      group.appendChild(lbl);
    }
    wrap.appendChild(group);
  } else {
    var items = document.createElement("div");
    items.className = "array-items";
    items.dataset.items = path;
    wrap.appendChild(items);

    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-btn";
    addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", function() { addArrayItem(items, path); });
    wrap.appendChild(addBtn);
  }

  return wrap;
}

function addArrayItem(itemsEl, path) {
  var row = document.createElement("div");
  row.className = "array-item";

  var input = document.createElement("input");
  input.type = "text";
  input.dataset.item = path;
  input.placeholder = "Enter value\u2026";
  row.appendChild(input);

  var rm = document.createElement("button");
  rm.type = "button";
  rm.className = "remove-btn";
  rm.textContent = "\u00d7";
  rm.addEventListener("click", function() { row.remove(); });
  row.appendChild(rm);

  itemsEl.appendChild(row);
  input.focus();
}

// ── Build / extract ─────────────────────────────────────────────────

function buildJsonFromForm(schema) {
  var result = {};
  var required = schema.required || [];
  var props = schema.properties || {};

  for (var name in props) {
    var prop = props[name];
    var isReq = required.indexOf(name) !== -1;

    // Optional object/array: skip if toggle unchecked
    if (!isReq && (prop.type === "object" || prop.type === "array")) {
      var toggle = document.querySelector("[data-toggle='" + name + "']");
      if (toggle && !toggle.checked) continue;
    }

    var val = extractValue(name, prop, name);

    if (isReq) {
      result[name] = val;
    } else if (prop.type === "boolean") {
      if (val === true) result[name] = true;
    } else if (prop.type === "string") {
      if (val) result[name] = val;
    } else if (prop.type === "array") {
      if (Array.isArray(val) && val.length > 0) result[name] = val;
    } else if (prop.type === "object") {
      result[name] = val;
    }
  }
  return result;
}

function extractValue(name, prop, path) {
  if (prop.type === "string") {
    var el = document.querySelector("[data-path='" + path + "']");
    return el ? el.value : "";
  }
  if (prop.type === "boolean") {
    var cb = document.querySelector("[data-path='" + path + "']");
    return cb ? cb.checked : false;
  }
  if (prop.type === "array") {
    var itemSchema = prop.items || {};
    if (itemSchema.enum) {
      var cbs = document.querySelectorAll("[data-array='" + path + "']");
      var vals = [];
      for (var i = 0; i < cbs.length; i++) { if (cbs[i].checked) vals.push(cbs[i].value); }
      return vals;
    }
    var inputs = document.querySelectorAll("[data-item='" + path + "']");
    var arr = [];
    for (var j = 0; j < inputs.length; j++) {
      var v = inputs[j].value.trim();
      if (v) arr.push(v);
    }
    return arr;
  }
  if (prop.type === "object" && prop.properties) {
    var obj = {};
    var subReq = prop.required || [];
    for (var sub in prop.properties) {
      var subVal = extractValue(sub, prop.properties[sub], path + "." + sub);
      var isSR = subReq.indexOf(sub) !== -1;
      if (isSR) {
        obj[sub] = subVal;
      } else if (prop.properties[sub].type === "boolean" && subVal === true) {
        obj[sub] = true;
      } else if (prop.properties[sub].type === "string" && subVal) {
        obj[sub] = subVal;
      } else if (prop.properties[sub].type === "array" && Array.isArray(subVal) && subVal.length > 0) {
        obj[sub] = subVal;
      }
    }
    return obj;
  }
  return undefined;
}

// ── Raw JSON toggle ─────────────────────────────────────────────────

function toggleRawJson() {
  if (rawJsonMode) {
    // Raw -> Structured
    var rawArea = document.getElementById("raw-json-area");
    try {
      var obj = JSON.parse(rawArea.value);
      renderSchemaForm(currentSchema);
      populateFormFromJson(currentSchema, obj);
      rawJsonMode = false;
    } catch(e) {
      rawArea.style.borderColor = "#dc3545";
      setTimeout(function() { rawArea.style.borderColor = ""; }, 1500);
    }
  } else {
    // Structured -> Raw
    var built = buildJsonFromForm(currentSchema);
    var area = document.getElementById("raw-json-area");
    area.value = JSON.stringify(built, null, 2);
    area.style.display = "block";
    var fields = container.querySelectorAll(".field-row, .bool-row, .options-header, .toggle-section");
    for (var i = 0; i < fields.length; i++) fields[i].style.display = "none";
    document.getElementById("raw-toggle").textContent = "Structured";
    rawJsonMode = true;
    area.focus();
  }
}

function populateFormFromJson(schema, obj) {
  var props = schema.properties || {};
  var required = schema.required || [];
  for (var name in props) {
    if (!(name in obj)) continue;
    var prop = props[name];
    var val = obj[name];
    var isReq = required.indexOf(name) !== -1;

    if (prop.type === "boolean") {
      var cb = document.querySelector("[data-path='" + name + "']");
      if (cb) cb.checked = !!val;
    } else if (prop.type === "string") {
      var el = document.querySelector("[data-path='" + name + "']");
      if (el) el.value = String(val);
    } else if (prop.type === "object") {
      if (!isReq) {
        var toggle = document.querySelector("[data-toggle='" + name + "']");
        if (toggle) {
          toggle.checked = true;
          toggle.closest(".toggle-section").classList.remove("collapsed");
        }
      }
      if (typeof val === "object" && val !== null) {
        populateObjectFields(prop, val, name);
      }
    } else if (prop.type === "array" && Array.isArray(val)) {
      populateArrayValues(prop, val, name);
    }
  }
}

function populateObjectFields(schema, obj, prefix) {
  for (var name in (schema.properties || {})) {
    if (!(name in obj)) continue;
    var prop = schema.properties[name];
    var path = prefix + "." + name;
    var val = obj[name];

    if (prop.type === "string") {
      var el = document.querySelector("[data-path='" + path + "']");
      if (el) el.value = String(val);
    } else if (prop.type === "boolean") {
      var cb = document.querySelector("[data-path='" + path + "']");
      if (cb) cb.checked = !!val;
    } else if (prop.type === "array" && Array.isArray(val)) {
      populateArrayValues(prop, val, path);
    }
  }
}

function populateArrayValues(prop, val, path) {
  var itemSchema = prop.items || {};
  if (itemSchema.enum) {
    var cbs = document.querySelectorAll("[data-array='" + path + "']");
    for (var i = 0; i < cbs.length; i++) cbs[i].checked = val.indexOf(cbs[i].value) !== -1;
  } else {
    var itemsEl = document.querySelector(".array-items[data-items='" + path + "']");
    if (itemsEl) {
      itemsEl.innerHTML = "";
      for (var j = 0; j < val.length; j++) {
        addArrayItem(itemsEl, path);
        var inputs = itemsEl.querySelectorAll("[data-item='" + path + "']");
        if (inputs.length > 0) inputs[inputs.length - 1].value = String(val[j]);
      }
    }
  }
}

function formatLabel(name) {
  return name.replace(/_/g, " ");
}

// ── Polling ─────────────────────────────────────────────────────────

function startPolling() {
  if (polling) return;
  polling = true;
  poll();
}

function poll() {
  if (!jobId || !polling) return;
  fetch(api("/v1/job/" + jobId + "/messages?after=" + lastSeq), {
    headers: jobHeaders(false),
  })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.messages) {
        for (var i = 0; i < data.messages.length; i++) {
          var msg = data.messages[i];
          lastSeq = Math.max(lastSeq, msg.seq);
          handleMessage(msg);
        }
      }
    })
    .catch(function() { /* ignore */ });
  if (polling) setTimeout(poll, 500);
}

// ── Message handling ────────────────────────────────────────────────

function handleMessage(msg) {
  if (msg.from === "provider") {
    switch (msg.type) {
      case "text":
        addMsg(msg.content.text, "msg-provider");
        break;
      case "working":
        addMsg("Working" + (msg.content.hint ? ": " + msg.content.hint : "..."), "msg-provider");
        break;
      case "progress": {
        var phase = msg.content.current_phase ? " (" + msg.content.current_phase + ")" : "";
        var hint = msg.content.hint ? " — " + msg.content.hint : "";
        addMsg("Progress: " + msg.content.percent_complete + "%" + phase + hint, "msg-provider");
        break;
      }
      case "artifact":
        addMsg("<pre>" + escHtml(msg.content.data || JSON.stringify(msg.content)) + "</pre>", "msg-provider");
        break;
      case "prompt":
        showPrompt(msg.content);
        break;
      case "payment-request":
        autoApprovePayment(msg.content);
        break;
      case "complete":
        addMsg("Summary: " + msg.content.summary, "msg-result");
        stopPolling();
        break;
      case "cancel":
        addMsg("Failed: " + (msg.content.reason || "cancelled"), "msg-error");
        stopPolling();
        break;
      default:
        addMsg(msg.type + ": " + JSON.stringify(msg.content), "msg-provider");
    }
  }
}

function showPrompt(content) {
  var div = document.createElement("div");
  div.className = "msg msg-provider";
  div.textContent = content.text;

  if (content.options && content.options.length > 0) {
    var opts = document.createElement("div");
    opts.className = "prompt-options";
    for (var i = 0; i < content.options.length; i++) {
      var btn = document.createElement("button");
      btn.textContent = content.options[i];
      btn.addEventListener("click", (function(val) {
        return function() { sendResponse(content.id, val); };
      })(content.options[i]));
      opts.appendChild(btn);
    }
    div.appendChild(opts);
  }

  var pf = document.createElement("div");
  pf.className = "prompt-form";
  var pi = document.createElement("input");
  pi.type = "text";
  pi.placeholder = "Type a response\u2026";
  var pb = document.createElement("button");
  pb.textContent = "Send";
  pb.addEventListener("click", function() { if (pi.value.trim()) sendResponse(content.id, pi.value.trim()); });
  pi.addEventListener("keydown", function(e) { if (e.key === "Enter" && pi.value.trim()) sendResponse(content.id, pi.value.trim()); });
  pf.appendChild(pi);
  pf.appendChild(pb);
  div.appendChild(pf);

  messagesEl.appendChild(div);
  pi.focus();
}

function sendResponse(promptId, text) {
  fetch(api("/v1/job/" + jobId + "/messages"), {
    method: "POST",
    headers: jobHeaders(true),
    body: JSON.stringify({ type: "response", content: { prompt_id: promptId, text: text } }),
  }).catch(function() { /* ignore */ });
}

function autoApprovePayment(content) {
  addMsg("Payment requested: " + (content.amount_msats || 0) + " msats \u2014 " + (content.reason || "") + " (auto-approved)", "msg-system");
  fetch(api("/v1/job/" + jobId + "/messages"), {
    method: "POST",
    headers: jobHeaders(true),
    // amount_msats rides along so an onPayment handler sees the same shape a
    // real rail would hand it. dev_auto is admitted on dev-mode servers only
    // hence the status check below rather than a silent catch.
    body: JSON.stringify({ type: "payment", content: { dev_auto: true, amount_msats: content.amount_msats || 0 } }),
  }).then(function(r) {
    if (!r.ok) addMsg("Auto-approve rejected (" + r.status + ") — dev mode only.", "msg-system");
  }).catch(function() { /* ignore */ });
}

function stopPolling() {
  polling = false;
  submitBtn.disabled = false;
}

// ── Helpers ─────────────────────────────────────────────────────────

function jobHeaders(hasBody) {
  var headers = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  if (jobToken) headers["X-Job-Token"] = jobToken;
  return headers;
}

function addMsg(html, cls) {
  var div = document.createElement("div");
  div.className = "msg " + cls;
  div.innerHTML = html;
  messagesEl.appendChild(div);
  div.scrollIntoView({ behavior: "smooth" });
}

function escHtml(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── Theme toggle ────────────────────────────────────────────────────

var themeBtn = document.getElementById("theme-toggle");

function updateThemeIcon() {
  themeBtn.textContent = document.documentElement.classList.contains("dark") ? "\u2600" : "\u263e";
}

themeBtn.addEventListener("click", function() {
  var isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("dvmkit-dev-theme", isDark ? "dark" : "light");
  updateThemeIcon();
});

updateThemeIcon();

// ── Init ────────────────────────────────────────────────────────────

initSchemaForm();
</script>
</body>
</html>`;
}
