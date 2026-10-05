(() => {
  "use strict";

  const PORTS = { mysql: "3306", postgresql: "5432", sqlserver: "1433" };

  const $ = (id) => document.getElementById(id);

  function fallbackToast(message) {
    const region = $("toastRegion");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 190);
    }, 2700);
  }

  function copyWithSelection(value) {
    const text = document.createElement("textarea");
    text.value = value;
    text.style.position = "fixed";
    text.style.opacity = "0";
    document.body.appendChild(text);
    try {
      text.select();
      if (!document.execCommand("copy")) throw new Error("copy failed");
    } finally {
      text.remove();
    }
  }

  function init({ signal, showToast = fallbackToast, sendAction, databaseName = "Prompt_Improve_DB", schemaData, schemaResult, selected = [], search = "" } = {}) {
    if (!$("connectionForm")) return;
    const ownController = signal ? null : new AbortController();
    const eventSignal = signal || ownController.signal;
    const state = { connected: false, busy: "", databases: [], selected: new Set(), output: "", copied: false };

    function step(number) {
      document.querySelectorAll("[data-step]").forEach((element) => {
        const value = Number(element.dataset.step);
        element.classList.toggle("is-done", value < number);
        element.classList.toggle("is-current", value === number);
      });
    }

    function clearOutput() {
      state.output = "";
      state.copied = false;
      $("schemaResult").textContent = "连接并选择数据表后，在这里生成结构说明。";
      $("schemaResult").classList.add("schema-result--empty");
      $("resultBadge").textContent = "待生成";
      $("resultCaption").textContent = "字段信息来自实际 SQLite 数据库；缺失的说明由 DeepSeek 补充。";
      $("regenerateButton").disabled = true;
      $("clearResultButton").disabled = true;
      $("copyButton").disabled = true;
    }

    function currentDatabase() {
      return state.databases.find((database) => database.name === $("databaseSelect").value);
    }

    function syncClearedResult() {
      if (sendAction) sendAction({
        action: "clear_schema_result",
        tables: [...state.selected],
        search: $("tableSearch").value,
      });
    }

    function renderTables() {
      const database = currentDatabase();
      const list = $("tableList");
      list.replaceChildren();
      const allTables = database?.tables || [];
      const query = $("tableSearch").value.trim().toLocaleLowerCase();
      const tables = allTables.filter((table) => table.name.toLocaleLowerCase().includes(query));
      $("tableCount").textContent = !state.connected ? "等待连接" : `${allTables.length} 张表`;
      $("selectedCount").innerHTML = `已选 <strong>${state.selected.size}</strong> 张表`;
      $("generateButton").disabled = !state.connected || !!state.busy || state.selected.size === 0;
      $("selectAllButton").disabled = !state.connected || !!state.busy || allTables.length === 0;
      $("clearSelectionButton").disabled = !state.connected || !!state.busy || state.selected.size === 0;

      if (!state.connected) {
        list.innerHTML = '<div class="schema-empty"><strong>尚未连接数据库</strong>连接成功后即可查看数据库和表。</div>';
      } else if (!database) {
        list.innerHTML = '<div class="schema-empty"><strong>没有可用数据库</strong>请检查连接配置后重试。</div>';
      } else if (!allTables.length) {
        list.innerHTML = '<div class="schema-empty"><strong>当前数据库没有数据表</strong>请选择其他数据库。</div>';
      } else if (!tables.length) {
        list.innerHTML = '<div class="schema-empty"><strong>没有匹配的表</strong>试试其他搜索词。</div>';
      } else {
        for (const table of tables) {
          const label = document.createElement("label");
          label.className = "schema-table";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = table.name;
          checkbox.checked = state.selected.has(table.name);
          checkbox.disabled = !!state.busy;
          const main = document.createElement("span");
          main.className = "schema-table__main";
          const name = document.createElement("span");
          name.className = "schema-table__name";
          name.textContent = table.name;
          const description = document.createElement("span");
          description.className = "schema-table__description";
          description.textContent = table.description || "待生成说明";
          main.append(name, description);
          const meta = document.createElement("span");
          meta.className = "schema-table__meta";
          meta.textContent = `${table.columns.length} 个字段`;
          label.append(checkbox, main, meta);
          list.appendChild(label);
        }
      }
    }

    function resetConnection() {
      state.connected = false;
      state.databases = [];
      state.selected.clear();
      $("databaseSelect").replaceChildren(new Option("请先连接数据库", ""));
      $("databaseSelect").disabled = true;
      $("tableSearch").value = "";
      $("tableSearch").disabled = true;
      $("connectionBadge").textContent = "未连接";
      $("connectionStatus").textContent = "配置已修改，请重新连接。";
      $("connectionStatus").dataset.tone = "";
      $("selectionStatus").textContent = "";
      clearOutput();
      renderTables();
      step(1);
    }

    function setBusy(kind, busy) {
      state.busy = busy ? kind : "";
      ["dbType", "dbHost", "dbPort", "dbName"].forEach((id) => {
        $(id).disabled = busy;
      });
      $("connectButton").disabled = busy;
      $("connectButton").textContent = kind === "connect" && busy ? "连接中…" : "连接数据库";
      $("generateButton").textContent = kind === "generate" && busy ? "生成中…" : "生成表结构";
      $("regenerateButton").disabled = busy || !state.output;
      $("copyButton").disabled = busy || !state.output;
      $("clearResultButton").disabled = busy || !state.output;
      $("databaseSelect").disabled = busy || !state.databases.length;
      $("tableSearch").disabled = busy || !currentDatabase()?.tables.length;
      renderTables();
    }

    function updateConnectionFields() {
      const type = $("dbType").value;
      const sqlite = type === "sqlite";
      $("dbHostField").hidden = sqlite;
      $("dbPortField").hidden = sqlite;
      $("dbHost").required = !sqlite;
      $("dbPort").required = !sqlite;
      $("dbNameLabel").textContent = sqlite ? "SQLite 文件" : "数据库名";
      const previous = $("dbName").value;
      $("dbName").replaceChildren(new Option(databaseName, databaseName));
      if (previous === databaseName) $("dbName").value = previous;
      $("connectionStatus").textContent = sqlite
        ? "SQLite 为本地文件数据库，无需主机地址和端口。"
        : "当前项目仅支持 SQLite 数据库。";
    }

    $("dbType").addEventListener("change", () => {
      $("dbPort").value = PORTS[$("dbType").value] || "";
      updateConnectionFields();
      resetConnection();
    }, { signal: eventSignal });
    ["dbHost", "dbPort", "dbName"].forEach((id) => {
      $(id).addEventListener(id === "dbName" ? "change" : "input", resetConnection, { signal: eventSignal });
    });

    $("connectionForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const host = $("dbHost").value.trim();
      const port = Number($("dbPort").value);
      const name = $("dbName").value.trim();
      const sqlite = $("dbType").value === "sqlite";
      resetConnection();
      if (!name || (!sqlite && (!host || !Number.isInteger(port) || port < 1 || port > 65535))) {
        $("connectionStatus").textContent = sqlite ? "请选择 SQLite 文件。" : "请填写主机地址、1–65535 的端口和数据库名。";
        $("connectionStatus").dataset.tone = "error";
        showToast("连接配置不完整");
        return;
      }
      setBusy("connect", true);
      $("connectionBadge").textContent = "连接中";
      $("connectionStatus").textContent = "正在连接数据库…";
      $("connectionStatus").dataset.tone = "busy";
      if (sendAction) sendAction({ action: "connect_schema", db_type: $("dbType").value, db_name: name });
      else {
        setBusy("connect", false);
        $("connectionStatus").textContent = "请从 Streamlit 应用打开此页面以连接数据库。";
        $("connectionStatus").dataset.tone = "error";
      }
    }, { signal: eventSignal });

    $("databaseSelect").addEventListener("change", () => {
      state.selected.clear();
      $("tableSearch").value = "";
      clearOutput();
      renderTables();
      $("tableSearch").disabled = !currentDatabase()?.tables.length;
      $("selectionStatus").textContent = currentDatabase()?.tables.length ? "请选择需要生成结构说明的数据表。" : "当前数据库没有数据表。";
      step(2);
    }, { signal: eventSignal });
    $("tableSearch").addEventListener("input", renderTables, { signal: eventSignal });
    $("tableList").addEventListener("change", (event) => {
      if (event.target.type !== "checkbox") return;
      if (event.target.checked) state.selected.add(event.target.value);
      else state.selected.delete(event.target.value);
      clearOutput();
      renderTables();
      $("selectionStatus").textContent = state.selected.size ? "可以生成所选表的结构说明。" : "请至少选择一张表。";
      step(state.selected.size ? 3 : 2);
    }, { signal: eventSignal });
    $("selectAllButton").addEventListener("click", () => {
      currentDatabase()?.tables.forEach((table) => state.selected.add(table.name));
      clearOutput();
      renderTables();
      $("selectionStatus").textContent = "已选择当前数据库的全部数据表。";
      step(3);
    }, { signal: eventSignal });
    $("clearSelectionButton").addEventListener("click", () => {
      state.selected.clear();
      clearOutput();
      renderTables();
      $("selectionStatus").textContent = "已清空选择，请至少选择一张表。";
      step(2);
    }, { signal: eventSignal });

    async function generate() {
      const selectedTables = currentDatabase()?.tables.filter((table) => state.selected.has(table.name)) || [];
      if (!selectedTables.length) {
        $("selectionStatus").textContent = "请至少选择一张表。";
        showToast("请先选择数据表");
        return;
      }
      setBusy("generate", true);
      $("resultBadge").textContent = "生成中";
      $("schemaResult").textContent = "正在生成表结构说明…";
      $("schemaResult").classList.add("schema-result--empty");
      step(3);
      if (sendAction) sendAction({ action: "generate_schema", tables: selectedTables.map((table) => table.name), search: $("tableSearch").value });
      else {
        setBusy("generate", false);
        $("schemaResult").textContent = "请从 Streamlit 应用打开此页面以生成说明。";
      }
    }
    $("generateButton").addEventListener("click", generate, { signal: eventSignal });
    $("regenerateButton").addEventListener("click", generate, { signal: eventSignal });
    $("clearResultButton").addEventListener("click", () => {
      clearOutput();
      step(state.selected.size ? 3 : 2);
      showToast("结果已清空");
      syncClearedResult();
    }, { signal: eventSignal });
    $("copyButton").addEventListener("click", async () => {
      if (!state.output) return;
      try {
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(state.output);
          } catch {
            copyWithSelection(state.output);
          }
        } else {
          copyWithSelection(state.output);
        }
        if (eventSignal.aborted) return;
        state.copied = true;
        showToast("复制成功，已保存到剪贴板");
      } catch {
        showToast("复制失败，请手动选择结果文本");
      }
    }, { signal: eventSignal });

    $("dbType").value = "sqlite";
    updateConnectionFields();
    $("dbName").value = databaseName;
    const badge = document.querySelector(".schema-demo-badge");
    if (badge) badge.textContent = "SQLite";
    const help = document.querySelector(".schema-field-help");
    if (help) help.textContent = "连接当前项目的 Prompt_Improve_DB 数据库，选择数据表后生成结构说明。";
    $("tableSearch").value = search;
    clearOutput();
    if (schemaData?.status === "success" && schemaData.database) {
      state.connected = true;
      state.databases = [schemaData.database];
      state.selected = new Set(selected);
      $("databaseSelect").replaceChildren(new Option(schemaData.database.name, schemaData.database.name));
      $("databaseSelect").disabled = false;
      $("tableSearch").disabled = !schemaData.database.tables.length;
      $("connectionBadge").textContent = "已连接";
      $("connectionStatus").textContent = `连接成功，发现 ${schemaData.database.tables.length} 张表。`;
      $("connectionStatus").dataset.tone = "success";
      $("selectionStatus").textContent = state.selected.size ? "可以生成所选表的结构说明。" : "请选择需要生成结构说明的数据表。";
      if (schemaResult?.status === "success") {
        state.output = schemaResult.output;
        $("schemaResult").textContent = state.output;
        $("schemaResult").classList.remove("schema-result--empty");
        $("resultBadge").textContent = `已生成 · ${schemaResult.tables.length} 张表`;
        $("resultCaption").textContent = `共 ${schemaResult.tables.length} 张表；可直接复制到 SQL 提示词。`;
        $("regenerateButton").disabled = false;
        $("clearResultButton").disabled = false;
        $("copyButton").disabled = false;
        $("selectionStatus").textContent = "生成成功，可以复制结果。";
        step(4);
      } else if (schemaResult?.status === "error") {
        $("schemaResult").textContent = schemaResult.message;
        $("resultBadge").textContent = "生成失败";
        $("selectionStatus").textContent = schemaResult.message;
        step(3);
      } else step(state.selected.size ? 3 : 2);
    } else {
      if (schemaData?.status === "error") {
        $("connectionBadge").textContent = "连接失败";
        $("connectionStatus").textContent = schemaData.message;
        $("connectionStatus").dataset.tone = "error";
      }
      step(1);
    }
    setBusy("", false);
    renderTables();

    if (ownController) {
      document.querySelectorAll("[data-collapse]").forEach((button) => {
        button.addEventListener("click", () => {
          const target = $(button.dataset.collapse);
          const expanded = button.getAttribute("aria-expanded") === "true";
          button.setAttribute("aria-expanded", String(!expanded));
          if (target) target.hidden = expanded;
        }, { signal: eventSignal });
      });
      $("menuToggle")?.addEventListener("click", () => {
        const open = $("sidebar").classList.toggle("is-open");
        $("mobileOverlay").classList.toggle("is-visible", open);
        $("menuToggle").setAttribute("aria-expanded", String(open));
      }, { signal: eventSignal });
      $("mobileOverlay")?.addEventListener("click", () => {
        $("sidebar").classList.remove("is-open");
        $("mobileOverlay").classList.remove("is-visible");
        $("menuToggle").setAttribute("aria-expanded", "false");
      }, { signal: eventSignal });
    }
  }

  window.ImprovePromptDbSchema = { init };
  if (!document.getElementById("app")) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init(), { once: true });
    else init();
  }
})();
