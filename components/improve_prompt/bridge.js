(() => {
  "use strict";

  const standalonePage = document.getElementById("app")
    ? null
    : ["prompt_eval", "prompt_list", "eval_results"].find((page) =>
        window.location.pathname.endsWith(`/${page}.html`)
      ) || null;
  const app = document.getElementById("app") || document.body;
  const STYLE_MARK = "data-improve-prompt-style";
  const PAGE_SIZE = 10;
  const MODEL_TYPES = ["对话", "视频", "嵌入", "生图", "语音", "重排"];
  const EVAL_PLANS_KEY = "improve_prompt_eval_plans";
  const EVAL_STATE_KEY = "improve_prompt_eval_state";
  const EVAL_RESULTS_KEY = "improve_prompt_eval_results";
  const EVAL_RESULT_SAMPLES_KEY = "improve_prompt_eval_result_samples_v1";
  const EDIT_CONTEXT_KEY = "improve_prompt_edit_context_v1";
  const DEFAULT_EVAL_PLANS = [
    {
      id: "mock-plan-support",
      name: "客服意图识别",
      server: "OpenAI",
      model: "GPT-5",
      systemPrompt:
        "你是一名客服质检助手。请判断用户问题的意图，并给出简洁、可执行的处理建议。",
      userPrompt: "请分析用户问题并输出意图分类、关键信息和处理建议。",
    },
    {
      id: "mock-plan-sql",
      name: "SQL 生成",
      server: "DeepSeek",
      model: "DeepSeek V3.2",
      systemPrompt:
        "你是一名 SQL 工程师。请根据数据库表结构生成可执行 SQL，不要编造不存在的字段。",
      userPrompt: "根据用户问题生成 SQL，并简要说明查询逻辑。",
    },
    {
      id: "mock-plan-summary",
      name: "会议纪要整理",
      server: "阿里云百炼",
      model: "通义千问",
      systemPrompt: "你是一名会议助理。请准确提炼会议结论、待办事项与负责人，不补充原文没有的信息。",
      userPrompt: "请将以下会议内容整理成简洁的纪要，并列出待办事项。",
    },
  ];
  const pages = new Set([
    "server_add",
    "server_list",
    "model_add",
    "model_list",
    "prompt_dis",
    "prompt_list",
    "prompt_eval",
    "eval_results",
    "db_schema",
  ]);
  const bridge = {
    args: {},
    controller: null,
    loadedPage: standalonePage,
    loadingPage: null,
    loadingPromise: null,
    renderVersion: 0,
    actionSequence: 0,
    lastToast: null,
    elapsedTimer: null,
  };

  function postToStreamlit(type, payload = {}) {
    if (standalonePage) return;
    window.parent.postMessage(
      {
        isStreamlitMessage: true,
        type,
        ...payload,
      },
      "*"
    );
  }

  function frameHeight() {
    try {
      return Math.max(320, window.parent.innerHeight || window.innerHeight);
    } catch {
      return Math.max(320, window.innerHeight);
    }
  }

  function setFrameHeight() {
    postToStreamlit("streamlit:setFrameHeight", {
      height: frameHeight(),
    });
  }

  function sendAction(action) {
    bridge.actionSequence += 1;
    postToStreamlit("streamlit:setComponentValue", {
      value: {
        ...action,
        token: `${Date.now()}-${bridge.actionSequence}`,
      },
    });
  }

  function navigate(page, toast = "") {
    if (standalonePage) {
      window.location.href = `${page}.html`;
      return;
    }
    bridge.lastToast = null;
    sendAction({ action: "navigate", page, toast });
  }

  function removeTemplateStyles() {
    document.querySelectorAll(`[${STYLE_MARK}]`).forEach((node) => node.remove());
  }

  function copyTemplateStyles(documentNode) {
    removeTemplateStyles();
    documentNode.head
      .querySelectorAll("style, link[rel='stylesheet']")
      .forEach((node) => {
        const clone = document.importNode(node, true);
        clone.setAttribute(STYLE_MARK, "true");
        document.head.appendChild(clone);
      });
  }

  async function loadTemplate(page, renderVersion) {
    if (bridge.loadedPage === page) {
      return true;
    }

    if (bridge.loadingPage !== page || !bridge.loadingPromise) {
      bridge.loadingPage = page;
      bridge.loadingPromise = (async () => {
        const response = await fetch(`${page}.html`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`页面模板加载失败：${response.status}`);
        }
        return new DOMParser().parseFromString(
          await response.text(),
          "text/html"
        );
      })().catch((error) => {
        bridge.loadingPage = null;
        bridge.loadingPromise = null;
        throw error;
      });
    }

    const documentNode = await bridge.loadingPromise;
    if (
      bridge.loadingPage !== page ||
      renderVersion !== bridge.renderVersion
    ) {
      return false;
    }

    copyTemplateStyles(documentNode);

    const fragment = document.createDocumentFragment();
    [...documentNode.body.children].forEach((node) => {
      if (node.tagName !== "SCRIPT") {
        fragment.appendChild(document.importNode(node, true));
      }
    });

    app.replaceChildren(fragment);
    document.title = documentNode.title || "Improve_Prompt";
    bridge.loadedPage = page;
    bridge.loadingPage = null;
    bridge.loadingPromise = null;
    const usesMainScrollbar = [
      "prompt_dis",
      "prompt_list",
      "prompt_eval",
      "eval_results",
      "db_schema",
      "model_list",
      "model_add",
    ].includes(page);
    document.documentElement.classList.toggle(
      "scroll-page",
      usesMainScrollbar
    );

    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    document.body.style.minHeight = "100vh";
    document.body.style.overflowX = "hidden";
    document.body.style.overflowY =
      usesMainScrollbar ? "hidden" : "auto";
    setFrameHeight();
    return true;
  }

  function resetBridgeListeners() {
    window.clearInterval(bridge.elapsedTimer);
    bridge.elapsedTimer = null;
    bridge.controller?.abort();
    bridge.controller = new AbortController();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function previewThirtyCharacters(value) {
    const characters = Array.from(String(value ?? ""));
    return characters.length > 30
      ? `${characters.slice(0, 30).join("")}…`
      : characters.join("");
  }

  function initialsFor(value) {
    const compact = String(value ?? "").replace(/\s+/g, "");
    return compact.slice(0, 2).toUpperCase();
  }

  function isValidUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function readStorageJson(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorageJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function readEditContext() {
    try { return JSON.parse(window.sessionStorage.getItem(EDIT_CONTEXT_KEY) || "null"); }
    catch { return null; }
  }

  function databasePlans() {
    return (bridge.args.prompts || []).map((prompt) => ({
      id: `db-${prompt.id}`,
      dbId: prompt.id,
      name: prompt.prompt_name || "",
      server: prompt.plat_name || "",
      model: prompt.mdl_name || "",
      modelId: prompt.model_id,
      systemPrompt: prompt.sys_prompt || "",
      userPrompt: prompt.user_prompt1 || "",
      userPrompts: [
        prompt.user_prompt1,
        prompt.user_prompt2,
        prompt.user_prompt3,
        prompt.user_prompt4,
      ].slice(0, prompt.u_promt_count || 1).map((value) => value || ""),
    }));
  }

  function includeDatabasePlans(plans) {
    const database = databasePlans();
    return [...database, ...plans.filter((plan) =>
      !database.some((saved) => saved.id === plan.id || (
        saved.name === plan.name &&
        saved.server === plan.server &&
        saved.model === plan.model &&
        saved.systemPrompt === plan.systemPrompt &&
        saved.userPrompt === plan.userPrompt
      ))
    )];
  }

  function evaluationPlans() {
    if (!standalonePage) return databasePlans();
    const saved = readStorageJson(EVAL_PLANS_KEY, null);
    let migrated = false;
    try { migrated = window.localStorage.getItem("improve_prompt_plans_migrated") === "1"; } catch { /* Storage may be disabled. */ }
    if (Array.isArray(saved)) {
      const defaultsToMigrate = DEFAULT_EVAL_PLANS.filter(
        (plan) => !saved.some((item) => item.id === plan.id)
      );
      // Existing installs stored only user-created plans; seed examples once.
      if (!migrated) {
        const initial = [...saved, ...defaultsToMigrate];
        writeStorageJson(EVAL_PLANS_KEY, initial);
        try { window.localStorage.setItem("improve_prompt_plans_migrated", "1"); } catch { /* Storage may be disabled. */ }
        return includeDatabasePlans(initial);
      }
      return includeDatabasePlans(saved);
    }
    const initial = DEFAULT_EVAL_PLANS.map((plan) => ({ ...plan }));
    writeStorageJson(EVAL_PLANS_KEY, initial);
    try { window.localStorage.setItem("improve_prompt_plans_migrated", "1"); } catch { /* Storage may be disabled. */ }
    return includeDatabasePlans(initial);
  }

  function evaluationResults() {
    if (!standalonePage) {
      return (bridge.args.evaluations || [])
        .filter((row) => row.m_answer && row.is_true !== null)
        .map((row) => ({
          id: String(row.id),
          runId: row.run_id || `legacy:${row.prompt_id}`,
          planId: `db-${row.prompt_id}`,
          planName: row.prompt_name || "评测方案",
          question: row.question || "",
          expected: row.s_answer || "",
          modelOutput: row.m_answer || "",
          judgment: row.is_true === 1 ? "正确" : "错误",
          originalJudgment: row.is_true === 1 ? "正确" : "错误",
          corrected: row.is_correct === 1,
          needsRerun: row.needs_rerun === 1,
          evaluatedAt: row.evaluated_at || "",
        }));
    }
    const saved = readStorageJson(EVAL_RESULTS_KEY, null);
    let samplesInitialized = false;
    try { samplesInitialized = window.localStorage.getItem(EVAL_RESULT_SAMPLES_KEY) === "1"; } catch { /* Storage may be disabled. */ }
    if (Array.isArray(saved)) {
      if (saved.length || samplesInitialized) return saved;
      const samples = sampleEvaluationResults();
      if (writeStorageJson(EVAL_RESULTS_KEY, samples)) {
        try { window.localStorage.setItem(EVAL_RESULT_SAMPLES_KEY, "1"); } catch { /* Storage may be disabled. */ }
      }
      return samples;
    }

    // Bring forward results saved before the dedicated history page existed.
    const state = readStorageJson(EVAL_STATE_KEY, null);
    const plan = evaluationPlans().find((item) => item.id === state?.selectedPlanId);
    const results = (Array.isArray(state?.rows) ? state.rows : [])
      .filter((row) => row.result && row.judgment !== "待判定")
      .map((row, index) => {
        row.resultId ||= `result-legacy-${Date.now()}-${index}`;
        row.originalJudgment ||= row.judgment;
        row.corrected = row.judgment !== row.originalJudgment;
        return {
          id: row.resultId,
          question: row.question,
          expected: row.expected,
          modelOutput: row.result,
          judgment: row.judgment,
          originalJudgment: row.originalJudgment,
          corrected: row.corrected,
          planId: plan?.id || "",
          planName: plan?.name || "评测方案",
          planSnapshot: plan ? { ...plan } : null,
          evaluatedAt: new Date().toISOString(),
        };
      });
    const initial = results.length ? results : sampleEvaluationResults();
    writeStorageJson(EVAL_RESULTS_KEY, initial);
    try { window.localStorage.setItem(EVAL_RESULT_SAMPLES_KEY, "1"); } catch { /* Storage may be disabled. */ }
    if (state && results.length) writeStorageJson(EVAL_STATE_KEY, state);
    return initial;
  }

  function sampleEvaluationResults() {
    const samplePlan = evaluationPlans().find((plan) => plan.id === "mock-plan-support");
    const examples = [
      { question: "用户说‘我想修改收货地址’，应归类为什么意图？", expected: "订单修改", modelOutput: "订单修改", judgment: "正确", originalJudgment: "正确", corrected: false },
      { question: "客户反馈商品破损，应优先转给哪个服务组？", expected: "售后服务", modelOutput: "订单咨询", judgment: "错误", originalJudgment: "错误", corrected: false },
      { question: "用户询问如何补开发票，应识别为什么意图？", expected: "发票服务", modelOutput: "订单咨询", judgment: "错误", originalJudgment: "正确", corrected: true },
    ];
    return examples.map((item, index) => ({
      id: `result-sample-${index + 1}`,
      runId: "sample-run-support",
      planId: "mock-plan-support",
      planSnapshot: samplePlan ? { ...samplePlan } : null,
      ...item,
      planName: samplePlan?.name || "客服意图识别",
      evaluatedAt: new Date(Date.now() - (examples.length - index) * 3600000).toISOString(),
    }));
  }

  function showToast(message) {
    if (!message) {
      return;
    }

    const toast = String(message);
    const now = Date.now();
    if (
      bridge.lastToast &&
      bridge.lastToast.text === toast &&
      now - bridge.lastToast.at < 1500
    ) {
      return;
    }
    bridge.lastToast = { text: toast, at: now };

    const toastRegion = document.getElementById("toastRegion");
    if (!toastRegion) {
      return;
    }

    const element = document.createElement("div");
    element.className = "toast";
    element.textContent = toast;
    toastRegion.appendChild(element);

    window.setTimeout(() => {
      element.classList.add("is-leaving");
      window.setTimeout(() => element.remove(), 190);
    }, 2700);
  }

  function closeSidebar() {
    const sidebar = document.getElementById("sidebar");
    const mobileOverlay = document.getElementById("mobileOverlay");
    const menuToggle = document.getElementById("menuToggle");
    sidebar?.classList.remove("is-open");
    mobileOverlay?.classList.remove("is-visible");
    menuToggle?.setAttribute("aria-expanded", "false");
  }

  function bindNavigation() {
    const signal = bridge.controller.signal;

    document.querySelectorAll("[data-collapse]").forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          const target = document.getElementById(button.dataset.collapse);
          const expanded = button.getAttribute("aria-expanded") === "true";
          button.setAttribute("aria-expanded", String(!expanded));
          if (target) {
            target.hidden = expanded;
          }
        },
        { signal }
      );
    });

    document.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href");

      if (
        href === "server_add.html" ||
        href === "server_list.html" ||
        href === "model_add.html" ||
        href === "model_list.html" ||
        href === "prompt_dis.html" ||
        href === "prompt_list.html" ||
        href === "prompt_eval.html" ||
        href === "eval_results.html" ||
        href === "db_schema.html"
      ) {
        if (standalonePage) return;
        link.addEventListener(
          "click",
          (event) => {
            event.preventDefault();
            closeSidebar();
            navigate(href.replace(".html", ""));
          },
          { signal }
        );
        return;
      }

      if (href === "#") {
        link.addEventListener(
          "click",
          (event) => {
            event.preventDefault();
            closeSidebar();
            showToast(
              bridge.loadedPage?.startsWith("model")
                ? "该模型暂未配置详情链接"
                : "该服务器暂未配置官网链接"
            );
          },
          { signal }
        );
      }
    });

    const menuToggle = document.getElementById("menuToggle");
    const sidebar = document.getElementById("sidebar");
    const mobileOverlay = document.getElementById("mobileOverlay");

    menuToggle?.addEventListener(
      "click",
      () => {
        const isOpen = sidebar.classList.toggle("is-open");
        mobileOverlay.classList.toggle("is-visible", isOpen);
        menuToggle.setAttribute("aria-expanded", String(isOpen));
      },
      { signal }
    );

    mobileOverlay?.addEventListener("click", closeSidebar, { signal });

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          closeSidebar();
        }
      },
      { signal }
    );
  }

  function setupCombo({ rootId, inputId, toggleId, menuId, onChoose }) {
    const root = document.getElementById(rootId);
    const input = document.getElementById(inputId);
    const toggle = document.getElementById(toggleId);
    const menu = document.getElementById(menuId);
    const options = [...menu.querySelectorAll(".combo__option")];
    const signal = bridge.controller.signal;
    let highlighted = -1;

    function updateHighlighted() {
      options.forEach((option, index) => {
        const selected = option.dataset.value === input.value;
        option.classList.toggle("is-highlighted", index === highlighted);
        option.classList.toggle("is-selected", selected);
        option.setAttribute("aria-selected", String(selected));
      });
    }

    function open() {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-expanded", "true");
      highlighted = options.length
        ? Math.max(
            0,
            options.findIndex(
              (option) => option.dataset.value === input.value
            )
          )
        : -1;
      updateHighlighted();
    }

    function close() {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      input.setAttribute("aria-expanded", "false");
      highlighted = -1;
      updateHighlighted();
    }

    function choose(value) {
      if (value === undefined) {
        return;
      }
      input.value = value;
      onChoose?.(value);
      close();
      input.focus();
    }

    toggle.addEventListener(
      "click",
      () => {
        if (menu.hidden) {
          open();
        } else {
          close();
        }
      },
      { signal }
    );

    input.addEventListener(
      "click",
      () => {
        if (menu.hidden) {
          open();
        }
      },
      { signal }
    );
    input.addEventListener(
      "input",
      () => {
        onChoose?.(input.value);
        open();
      },
      { signal }
    );

    options.forEach((option, index) => {
      option.addEventListener(
        "mouseenter",
        () => {
          highlighted = index;
          updateHighlighted();
        },
        { signal }
      );
      option.addEventListener("mousedown", (event) => event.preventDefault(), {
        signal,
      });
      option.addEventListener(
        "click",
        () => choose(option.dataset.value),
        { signal }
      );
    });

    input.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (menu.hidden) {
            open();
          } else if (options.length) {
            highlighted = Math.min(highlighted + 1, options.length - 1);
            updateHighlighted();
          }
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          highlighted = Math.max(highlighted - 1, 0);
          updateHighlighted();
        }

        if (event.key === "Enter" && !menu.hidden && highlighted >= 0) {
          event.preventDefault();
          choose(options[highlighted]?.dataset.value);
        }

        if (event.key === "Escape") {
          close();
        }
      },
      { signal }
    );

    document.addEventListener(
      "mousedown",
      (event) => {
        if (!root.contains(event.target)) {
          close();
        }
      },
      { signal }
    );

    return { close };
  }

  function renderServerAdd(args) {
    const form = document.getElementById("serverForm");
    const cancelButton = document.getElementById("cancelButton");
    const fields = {
      platform: {
        input: document.getElementById("platformInput"),
        error: document.getElementById("platformError"),
        validate: (value) => (value ? "" : "请选择或输入平台名称"),
      },
      baseUrl: {
        input: document.getElementById("apiInput"),
        error: document.getElementById("apiError"),
        validate: (value) => {
          if (!value) return "请输入 API 网址";
          return isValidUrl(value) ? "" : "请输入完整的 http:// 或 https:// 地址";
        },
      },
      company: {
        input: document.getElementById("companyInput"),
        error: document.getElementById("companyError"),
        validate: (value) => (value ? "" : "请输入公司名称"),
      },
      homepage: {
        input: document.getElementById("homepageInput"),
        error: document.getElementById("homepageError"),
        validate: (value) => {
          if (!value) return "请输入首页地址";
          return isValidUrl(value) ? "" : "请输入完整的 http:// 或 https:// 地址";
        },
      },
    };

    populateComboOptions(
      "platformMenu",
      uniqueServerPlatforms(args.server_options || [])
    );

    const platformCombo = setupCombo({
      rootId: "platformCombo",
      inputId: "platformInput",
      toggleId: "platformToggle",
      menuId: "platformMenu",
      onChoose: () => clearFieldError(fields.platform),
    });

    function clearFieldError(field) {
      field.input.setAttribute("aria-invalid", "false");
      field.error.textContent = "";
    }

    function setFieldError(field, message) {
      field.input.setAttribute("aria-invalid", "true");
      field.error.textContent = message;
    }

    function validateForm() {
      let firstInvalidInput = null;

      Object.values(fields).forEach((field) => {
        const message = field.validate(field.input.value.trim());
        if (message) {
          setFieldError(field, message);
          firstInvalidInput ||= field.input;
        } else {
          clearFieldError(field);
        }
      });

      if (firstInvalidInput) {
        platformCombo.close();
        firstInvalidInput.focus();
        return false;
      }
      return true;
    }

    Object.values(fields).forEach((field) => {
      field.input.addEventListener(
        "input",
        () => {
          if (field.input.getAttribute("aria-invalid") === "true") {
            clearFieldError(field);
          }
        },
        { signal: bridge.controller.signal }
      );
      field.input.addEventListener(
        "blur",
        () => {
          const message = field.validate(field.input.value.trim());
          if (message && field.input.value.trim()) {
            setFieldError(field, message);
          }
        },
        { signal: bridge.controller.signal }
      );
    });

    form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        platformCombo.close();

        if (!validateForm()) {
          showToast("请先完善服务器信息");
          return;
        }

        const submitButton = form.querySelector('button[type="submit"]');
        const submitLabel = submitButton.querySelector("span");
        submitButton.disabled = true;
        submitLabel.textContent = "保存中";

        sendAction({
          action: "create",
          plat_name: fields.platform.input.value.trim(),
          base_url: fields.baseUrl.input.value.trim(),
          co_name: fields.company.input.value.trim(),
          home_url: fields.homepage.input.value.trim(),
        });
      },
      { signal: bridge.controller.signal }
    );

    cancelButton.addEventListener(
      "click",
      () => navigate("server_list"),
      { signal: bridge.controller.signal }
    );

    bindNavigation();
  }

  function serverViewModel(server) {
    const homepage = server.home_url || "#";
    return {
      id: Number(server.id),
      platform: server.plat_name,
      platformUrl: homepage,
      initials: initialsFor(server.plat_name),
      company: server.co_name,
      companyUrl: homepage,
      api: server.base_url,
      darkMark: false,
    };
  }

  function renderServerList(args) {
    const servers = (args.servers || []).map(serverViewModel);
    const selectedIds = new Set();
    const signal = bridge.controller.signal;

    const tableBody = document.getElementById("serverTableBody");
    const tableScroll = document.querySelector(".table-scroll");
    const emptyState = document.getElementById("emptyState");
    const selectAll = document.getElementById("selectAll");
    const selectedCount = document.getElementById("selectedCount");
    const editButton = document.getElementById("editButton");
    const deleteButton = document.getElementById("deleteButton");
    const totalCount = document.getElementById("totalCount");
    const footerCount = document.getElementById("footerCount");
    const searchForm = document.getElementById("searchForm");
    const platformSearch = document.getElementById("platformSearch");
    const companySearch = document.getElementById("companySearch");
    const resetButton = document.getElementById("resetButton");
    const refreshButton = document.getElementById("refreshButton");
    const deleteModal = document.getElementById("deleteModal");
    const deleteConfirmCopy = document.getElementById("deleteConfirmCopy");
    const confirmDeleteButton = document.getElementById("confirmDeleteButton");
    const editModal = document.getElementById("editServerModal");
    const editServerForm = document.getElementById("editServerForm");
    const pagination = document.querySelector(".pagination");
    let currentPage = 1;
    let pageServerIds = [];

    platformSearch.value = args.filters?.server?.platform || "";
    companySearch.value = args.filters?.server?.company || "";

    function renderPagination(totalPages) {
      const fragment = document.createDocumentFragment();
      const previous = document.createElement("button");
      previous.className = "page-button";
      previous.type = "button";
      previous.setAttribute("aria-label", "上一页");
      previous.disabled = currentPage === 1;
      previous.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>';
      previous.addEventListener(
        "click",
        () => {
          if (currentPage > 1) {
            currentPage -= 1;
            renderTable();
          }
        },
        { signal }
      );
      fragment.appendChild(previous);

      for (let page = 1; page <= totalPages; page += 1) {
        const button = document.createElement("button");
        button.className = `page-button${
          page === currentPage ? " is-current" : ""
        }`;
        button.type = "button";
        button.textContent = String(page);
        if (page === currentPage) {
          button.setAttribute("aria-current", "page");
        }
        button.addEventListener(
          "click",
          () => {
            currentPage = page;
            renderTable();
          },
          { signal }
        );
        fragment.appendChild(button);
      }

      const next = document.createElement("button");
      next.className = "page-button";
      next.type = "button";
      next.setAttribute("aria-label", "下一页");
      next.disabled = currentPage === totalPages;
      next.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
      next.addEventListener(
        "click",
        () => {
          if (currentPage < totalPages) {
            currentPage += 1;
            renderTable();
          }
        },
        { signal }
      );
      fragment.appendChild(next);
      pagination.replaceChildren(fragment);
      pagination.hidden = servers.length <= PAGE_SIZE;
    }

    function renderTable() {
      const totalPages = Math.max(1, Math.ceil(servers.length / PAGE_SIZE));
      currentPage = Math.min(Math.max(currentPage, 1), totalPages);
      const startIndex = (currentPage - 1) * PAGE_SIZE;
      const pageServers = servers.slice(startIndex, startIndex + PAGE_SIZE);
      pageServerIds = pageServers.map((server) => server.id);

      tableBody.innerHTML = pageServers
        .map((server) => {
          const isSelected = selectedIds.has(server.id);
          return `
            <tr class="${isSelected ? "is-selected" : ""}" data-server-id="${server.id}">
              <td>
                <label class="checkbox-wrap">
                  <span class="sr-only">选择 ${escapeHtml(server.platform)}</span>
                  <input class="table-check row-check" type="checkbox" value="${server.id}" ${isSelected ? "checked" : ""}>
                </label>
              </td>
              <td>
                <a class="platform-cell" href="${escapeHtml(server.platformUrl)}" target="_blank" rel="noreferrer" title="打开 ${escapeHtml(server.platform)} 官网">
                  <span class="platform-mark ${server.darkMark ? "platform-mark--dark" : ""}">${escapeHtml(server.initials || initialsFor(server.platform))}</span>
                  <span>${escapeHtml(server.platform)}</span>
                </a>
              </td>
              <td>
                <a class="company-cell" href="${escapeHtml(server.companyUrl)}" target="_blank" rel="noreferrer" title="打开 ${escapeHtml(server.company)} 官网">
                  ${escapeHtml(server.company)}
                </a>
              </td>
              <td>
                <span class="api" title="${escapeHtml(server.api)}">${escapeHtml(server.api)}</span>
              </td>
            </tr>
          `;
        })
        .join("");

      const hasRows = pageServers.length > 0;
      emptyState.hidden = hasRows;
      tableScroll.hidden = !hasRows;

      const allVisibleSelected =
        hasRows && pageServers.every((server) => selectedIds.has(server.id));
      const someVisibleSelected =
        hasRows && pageServers.some((server) => selectedIds.has(server.id));
      selectAll.checked = allVisibleSelected;
      selectAll.indeterminate = someVisibleSelected && !allVisibleSelected;

      const selectedTotal = selectedIds.size;
      selectedCount.textContent = selectedTotal
        ? `已选择 ${selectedTotal} 项`
        : "未选择";
      selectedCount.classList.toggle("has-selection", selectedTotal > 0);
      editButton.disabled = selectedTotal !== 1;
      deleteButton.disabled = selectedTotal === 0;
      totalCount.textContent = `共 ${servers.length} 个服务器`;
      footerCount.textContent = hasRows
        ? `显示 ${startIndex + 1}-${startIndex + pageServers.length} 条，共 ${servers.length} 条`
        : "显示 0 条记录";
      renderPagination(totalPages);
    }

    function openModal(modal) {
      modal.hidden = false;
      document.body.style.overflow = "hidden";
      const focusTarget = modal.querySelector("input, button");
      window.setTimeout(() => focusTarget?.focus(), 0);
    }

    function closeModal(modal) {
      modal.hidden = true;
      if (deleteModal.hidden && editModal.hidden) {
        document.body.style.overflow = "";
        document.body.style.overflowY = "auto";
      }
    }

    function openEditModal() {
      if (selectedIds.size !== 1) {
        return;
      }
      const server = servers.find((item) => selectedIds.has(item.id));
      if (!server) {
        return;
      }

      editServerForm.elements.id.value = String(server.id);
      editServerForm.elements.plat_name.value = server.platform;
      editServerForm.elements.base_url.value = server.api;
      editServerForm.elements.co_name.value = server.company;
      editServerForm.elements.home_url.value =
        server.platformUrl === "#" ? "" : server.platformUrl;
      openModal(editModal);
    }

    renderTable();

    searchForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        sendAction({
          action: "search_servers",
          platform: platformSearch.value,
          company: companySearch.value,
        });
      },
      { signal }
    );

    resetButton.addEventListener(
      "click",
      () => {
        platformSearch.value = "";
        companySearch.value = "";
        sendAction({ action: "search_servers", platform: "", company: "" });
      },
      { signal }
    );

    refreshButton.addEventListener(
      "click",
      (event) => {
        const icon = event.currentTarget.querySelector("svg");
        icon?.animate(
          [
            { transform: "rotate(0deg)" },
            { transform: "rotate(360deg)" },
          ],
          { duration: 480, easing: "ease-out" }
        );
        sendAction({
          action: "search_servers",
          platform: platformSearch.value,
          company: companySearch.value,
          refresh: true,
        });
      },
      { signal }
    );

    selectAll.addEventListener(
      "change",
      () => {
        pageServerIds.forEach((serverId) => {
          if (selectAll.checked) {
            selectedIds.add(serverId);
          } else {
            selectedIds.delete(serverId);
          }
        });
        renderTable();
      },
      { signal }
    );

    tableBody.addEventListener(
      "change",
      (event) => {
        if (!event.target.classList.contains("row-check")) {
          return;
        }
        const serverId = Number(event.target.value);
        if (event.target.checked) {
          selectedIds.add(serverId);
        } else {
          selectedIds.delete(serverId);
        }
        renderTable();
      },
      { signal }
    );

    editButton.addEventListener("click", openEditModal, { signal });

    deleteButton.addEventListener(
      "click",
      () => {
        deleteConfirmCopy.innerHTML = `将删除 <strong>${selectedIds.size}</strong> 个服务器配置，此操作无法撤销。`;
        openModal(deleteModal);
      },
      { signal }
    );

    confirmDeleteButton.addEventListener(
      "click",
      () => {
        confirmDeleteButton.disabled = true;
        sendAction({ action: "delete_servers", ids: [...selectedIds] });
      },
      { signal }
    );

    editServerForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        sendAction({
          action: "update_server",
          id: Number(editServerForm.elements.id.value),
          plat_name: editServerForm.elements.plat_name.value.trim(),
          base_url: editServerForm.elements.base_url.value.trim(),
          co_name: editServerForm.elements.co_name.value.trim(),
          home_url: editServerForm.elements.home_url.value.trim(),
        });
      },
      { signal }
    );

    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener(
        "click",
        () => closeModal(document.getElementById(button.dataset.closeModal)),
        { signal }
      );
    });

    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener(
        "mousedown",
        (event) => {
          if (event.target === backdrop) {
            closeModal(backdrop);
          }
        },
        { signal }
      );
    });

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          if (!deleteModal.hidden) {
            closeModal(deleteModal);
          } else if (!editModal.hidden) {
            closeModal(editModal);
          }
        }
      },
      { signal }
    );

    bindNavigation();
  }

  function populateComboOptions(menuId, entries) {
    const menu = document.getElementById(menuId);
    const fragment = document.createDocumentFragment();

    entries.forEach((entry) => {
      const option = document.createElement("button");
      option.className = "combo__option";
      option.type = "button";
      option.setAttribute("role", "option");
      option.dataset.value = entry.value;
      option.textContent = entry.label;
      fragment.appendChild(option);
    });

    menu.replaceChildren(fragment);
  }

  function uniqueServerPlatforms(servers) {
    const seen = new Set();
    const entries = [];
    servers.forEach((server) => {
      const value = String(server.plat_name || "");
      if (!value || seen.has(value)) {
        return;
      }
      seen.add(value);
      entries.push({ value, label: value });
    });
    return entries;
  }

  function populateServerSelect(select, servers) {
    const fragment = document.createDocumentFragment();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请选择服务器";
    fragment.appendChild(placeholder);

    servers.forEach((server) => {
      const option = document.createElement("option");
      option.value = String(server.id);
      option.textContent = `${server.plat_name} · ${server.co_name}`;
      fragment.appendChild(option);
    });

    select.replaceChildren(fragment);
  }

  function decimalText(value) {
    if (value === null || value === undefined || value === "") {
      return "0";
    }

    let text = String(value).trim();
    if (/e/i.test(text)) {
      text = Number(text).toFixed(20);
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
      return "0";
    }

    text = text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return text === "-0" ? "0" : text;
  }

  function splitDecimal(value) {
    const text = decimalText(value);
    const negative = text.startsWith("-");
    const unsigned = negative ? text.slice(1) : text;
    const [whole, fraction = ""] = unsigned.split(".");
    return {
      negative,
      digits: `${whole || "0"}${fraction}`,
      scale: fraction.length,
    };
  }

  function tokenCost(tokens, unitPrice, divisor) {
    const tokenCount = BigInt(Math.max(0, Math.trunc(Number(tokens) || 0)));
    const { negative, digits, scale } = splitDecimal(unitPrice);
    const unitDivisor = Math.max(1, Math.trunc(divisor));
    const decimalPlaces = scale + String(unitDivisor).length - 1;
    const divisorValue =
      10n ** BigInt(scale) * BigInt(unitDivisor);
    const numerator = BigInt(digits) * tokenCount;
    const whole = numerator / divisorValue;
    const remainder = numerator % divisorValue;
    if (remainder === 0n) {
      return `${negative ? "-" : ""}${whole}`;
    }

    const fraction = remainder
      .toString()
      .padStart(decimalPlaces, "0")
      .replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }

  function addDecimalValues(left, right) {
    const leftValue = splitDecimal(left);
    const rightValue = splitDecimal(right);
    const scale = Math.max(leftValue.scale, rightValue.scale);
    const leftInteger =
      BigInt(leftValue.digits) *
      10n ** BigInt(scale - leftValue.scale);
    const rightInteger =
      BigInt(rightValue.digits) *
      10n ** BigInt(scale - rightValue.scale);
    const leftSigned = leftValue.negative ? -leftInteger : leftInteger;
    const rightSigned = rightValue.negative ? -rightInteger : rightInteger;
    const total = leftSigned + rightSigned;
    const negative = total < 0n;
    const absolute = negative ? -total : total;
    if (scale === 0) {
      const result = absolute.toString();
      return negative && result !== "0" ? `-${result}` : result;
    }
    const digits = absolute.toString().padStart(scale + 1, "0");
    const whole = digits.slice(0, -scale) || "0";
    const fraction = digits.slice(-scale).replace(/0+$/, "");
    const result = fraction ? `${whole}.${fraction}` : whole;
    return negative && result !== "0" ? `-${result}` : result;
  }

  function formatUnitPrice(value) {
    return `¥${decimalText(value)}`;
  }

  function formatCost(value) {
    return formatUnitPrice(value);
  }

  function modelViewModel(model) {
    return {
      id: Number(model.id),
      srvId: Number(model.srv_id),
      platform: model.plat_name,
      platformUrl: model.home_url || "#",
      initials: initialsFor(model.plat_name),
      model: model.mdl_name,
      modelUrl: model.url || "#",
      type: String(model.mdl_type || "").replaceAll(",", "、"),
      rawType: String(model.mdl_type || ""),
      inputCost: model.in_tok_fee ?? 0,
      outputCost: model.out_tok_fee ?? 0,
      unit: model.unit || "百万",
      darkMark: false,
    };
  }

  function renderModelAdd(args) {
    const form = document.getElementById("modelForm");
    const serverInput = document.getElementById("serverInput");
    const modelNameInput = document.getElementById("modelNameInput");
    const inputCostInput = document.getElementById("inputCostInput");
    const outputCostInput = document.getElementById("outputCostInput");
    const unitInput = document.getElementById("unitInput");
    const urlInput = document.getElementById("urlInput");
    const typeSelect = document.getElementById("typeSelect");
    const typeTrigger = document.getElementById("typeTrigger");
    const typeMenu = document.getElementById("typeMenu");
    const typeSummary = document.getElementById("typeSummary");
    const typeError = document.getElementById("typeError");
    const typeCheckboxes = [
      ...typeMenu.querySelectorAll('input[type="checkbox"]'),
    ];
    const cancelButton = document.getElementById("cancelButton");
    const signal = bridge.controller.signal;

    populateServerSelect(serverInput, args.server_options || []);

    const fields = {
      server: {
        input: serverInput,
        error: document.getElementById("serverError"),
        validate: (value) => (value ? "" : "请选择服务器"),
      },
      modelName: {
        input: modelNameInput,
        error: document.getElementById("modelNameError"),
        validate: (value) => (value ? "" : "请输入模型名称"),
      },
      inputCost: {
        input: inputCostInput,
        error: document.getElementById("inputCostError"),
        validate: validateCost,
      },
      outputCost: {
        input: outputCostInput,
        error: document.getElementById("outputCostError"),
        validate: validateOptionalCost,
      },
      unit: {
        input: unitInput,
        error: document.getElementById("unitError"),
        validate: (value) => (value ? "" : "请选择计费单位"),
      },
      url: {
        input: urlInput,
        error: document.getElementById("urlError"),
        validate: validateUrl,
      },
    };

    function validateCost(value) {
      if (!value) {
        return "请输入 Token 计费";
      }
      if (!/^\d+(\.\d+)?$/.test(value) || Number(value) < 0) {
        return "只能输入数字和小数点";
      }
      return "";
    }

    function validateOptionalCost(value) {
      return value ? validateCost(value) : "";
    }

    function validateUrl(value) {
      if (!value) {
        return "请输入网址";
      }
      if (!isValidUrl(value)) {
        return "请输入完整的 http:// 或 https:// 地址";
      }
      return "";
    }

    function sanitizeDecimal(input) {
      let value = input.value.replace(/[^\d.]/g, "");
      const firstDot = value.indexOf(".");
      if (firstDot !== -1) {
        value = `${value.slice(0, firstDot + 1)}${value
          .slice(firstDot + 1)
          .replaceAll(".", "")}`;
      }
      input.value = value;
    }

    function getSelectedTypes() {
      return typeCheckboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value);
    }

    function updateTypeSummary() {
      const selectedTypes = getSelectedTypes();
      typeSummary.classList.toggle("is-placeholder", selectedTypes.length === 0);
      if (!selectedTypes.length) {
        typeSummary.textContent = "请选择模型类型";
      } else if (selectedTypes.length === 1) {
        typeSummary.textContent = selectedTypes[0];
      } else {
        typeSummary.textContent = `${selectedTypes[0]} 等 ${selectedTypes.length} 项`;
      }
    }

    function closeTypeMenu() {
      typeMenu.hidden = true;
      typeTrigger.setAttribute("aria-expanded", "false");
    }

    function clearFieldError(field) {
      field.input.setAttribute("aria-invalid", "false");
      field.error.textContent = "";
    }

    function setFieldError(field, message) {
      field.input.setAttribute("aria-invalid", "true");
      field.error.textContent = message;
    }

    function validateForm() {
      let firstInvalidInput = null;

      Object.values(fields).forEach((field) => {
        const message = field.validate(field.input.value.trim());
        if (message) {
          setFieldError(field, message);
          firstInvalidInput ||= field.input;
        } else {
          clearFieldError(field);
        }
      });

      if (!getSelectedTypes().length) {
        typeTrigger.setAttribute("aria-invalid", "true");
        typeError.textContent = "请至少选择一种模型类型";
        firstInvalidInput ||= typeTrigger;
      } else {
        typeTrigger.setAttribute("aria-invalid", "false");
        typeError.textContent = "";
      }

      if (firstInvalidInput) {
        firstInvalidInput.focus();
        return false;
      }
      return true;
    }

    typeTrigger.addEventListener(
      "click",
      () => {
        if (typeMenu.hidden) {
          typeMenu.hidden = false;
          typeTrigger.setAttribute("aria-expanded", "true");
        } else {
          closeTypeMenu();
        }
      },
      { signal }
    );

    typeCheckboxes.forEach((checkbox) => {
      checkbox.addEventListener(
        "change",
        () => {
          updateTypeSummary();
          typeTrigger.setAttribute("aria-invalid", "false");
          typeError.textContent = "";
        },
        { signal }
      );
    });

    [inputCostInput, outputCostInput].forEach((input) => {
      input.addEventListener("input", () => sanitizeDecimal(input), { signal });
    });

    Object.values(fields).forEach((field) => {
      field.input.addEventListener("input", () => clearFieldError(field), {
        signal,
      });
      field.input.addEventListener("change", () => clearFieldError(field), {
        signal,
      });
    });

    form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        closeTypeMenu();

        if (!validateForm()) {
          showToast("请先完善模型信息");
          return;
        }

        const submitButton = form.querySelector('button[type="submit"]');
        const submitLabel = submitButton.querySelector("span");
        submitButton.disabled = true;
        submitLabel.textContent = "保存中";

        sendAction({
          action: "create_model",
          srv_id: Number(serverInput.value),
          mdl_name: modelNameInput.value.trim(),
          in_tok_fee: inputCostInput.value.trim(),
          out_tok_fee: outputCostInput.value.trim() || "0",
          unit: unitInput.value,
          mdl_type: getSelectedTypes().join(","),
          url: urlInput.value.trim(),
        });
      },
      { signal }
    );

    cancelButton.addEventListener("click", () => navigate("model_list"), {
      signal,
    });

    document.addEventListener(
      "mousedown",
      (event) => {
        if (!typeSelect.contains(event.target)) {
          closeTypeMenu();
        }
      },
      { signal }
    );

    bindNavigation();
    updateTypeSummary();
  }

  function renderModelList(args) {
    const models = (args.models || []).map(modelViewModel);
    const serverOptions = args.server_options || [];
    const platformOptions = uniqueServerPlatforms(serverOptions);
    const selectedIds = new Set();
    const signal = bridge.controller.signal;

    populateComboOptions("searchPlatformMenu", platformOptions);
    populateComboOptions("addPlatformMenu", platformOptions);
    populateComboOptions(
      "searchTypeMenu",
      MODEL_TYPES.map((value) => ({ value, label: value }))
    );
    populateComboOptions(
      "addTypeMenu",
      MODEL_TYPES.map((value) => ({ value, label: value }))
    );

    const tableBody = document.getElementById("modelTableBody");
    const tableScroll = document.querySelector(".table-scroll");
    const emptyState = document.getElementById("emptyState");
    const selectAll = document.getElementById("selectAll");
    const selectedCount = document.getElementById("selectedCount");
    const editButton = document.getElementById("editButton");
    const deleteButton = document.getElementById("deleteButton");
    const totalCount = document.getElementById("totalCount");
    const footerCount = document.getElementById("footerCount");
    const searchForm = document.getElementById("searchForm");
    const searchPlatformInput = document.getElementById("searchPlatformInput");
    const searchTypeInput = document.getElementById("searchTypeInput");
    const modelSearchInput = document.getElementById("modelSearchInput");
    const inputCostMin = document.getElementById("inputCostMin");
    const inputCostMax = document.getElementById("inputCostMax");
    const outputCostMin = document.getElementById("outputCostMin");
    const outputCostMax = document.getElementById("outputCostMax");
    const resetButton = document.getElementById("resetButton");
    const refreshButton = document.getElementById("refreshButton");
    const addModal = document.getElementById("addModal");
    const deleteModal = document.getElementById("deleteModal");
    const deleteConfirmCopy = document.getElementById("deleteConfirmCopy");
    const confirmDeleteButton = document.getElementById("confirmDeleteButton");
    const addModelForm = document.getElementById("addModelForm");
    const editModal = document.getElementById("editModelModal");
    const editModelForm = document.getElementById("editModelForm");
    const pagination = document.querySelector(".pagination");
    let currentPage = 1;
    let pageModelIds = [];

    const modelFilters = args.filters?.model || {};
    searchPlatformInput.value = modelFilters.platform || "";
    searchTypeInput.value = modelFilters.type || "";
    modelSearchInput.value = modelFilters.model || "";
    inputCostMin.value = modelFilters.input_min ?? "";
    inputCostMax.value = modelFilters.input_max ?? "";
    outputCostMin.value = modelFilters.output_min ?? "";
    outputCostMax.value = modelFilters.output_max ?? "";

    const searchPlatformCombo = setupCombo({
      rootId: "searchPlatformCombo",
      inputId: "searchPlatformInput",
      toggleId: "searchPlatformToggle",
      menuId: "searchPlatformMenu",
    });
    const searchTypeCombo = setupCombo({
      rootId: "searchTypeCombo",
      inputId: "searchTypeInput",
      toggleId: "searchTypeToggle",
      menuId: "searchTypeMenu",
    });
    const addPlatformCombo = setupCombo({
      rootId: "addPlatformCombo",
      inputId: "addPlatformInput",
      toggleId: "addPlatformToggle",
      menuId: "addPlatformMenu",
    });
    const addTypeCombo = setupCombo({
      rootId: "addTypeCombo",
      inputId: "addTypeInput",
      toggleId: "addTypeToggle",
      menuId: "addTypeMenu",
    });

    const combos = [
      searchPlatformCombo,
      searchTypeCombo,
      addPlatformCombo,
      addTypeCombo,
    ];

    function closeAllCombos() {
      combos.forEach((combo) => combo.close());
    }

    function renderPagination(totalPages) {
      const fragment = document.createDocumentFragment();
      const previous = document.createElement("button");
      previous.className = "page-button";
      previous.type = "button";
      previous.setAttribute("aria-label", "上一页");
      previous.disabled = currentPage === 1;
      previous.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>';
      previous.addEventListener(
        "click",
        () => {
          if (currentPage > 1) {
            currentPage -= 1;
            renderTable();
          }
        },
        { signal }
      );
      fragment.appendChild(previous);

      for (let page = 1; page <= totalPages; page += 1) {
        const button = document.createElement("button");
        button.className = `page-button${
          page === currentPage ? " is-current" : ""
        }`;
        button.type = "button";
        button.textContent = String(page);
        if (page === currentPage) {
          button.setAttribute("aria-current", "page");
        }
        button.addEventListener(
          "click",
          () => {
            currentPage = page;
            renderTable();
          },
          { signal }
        );
        fragment.appendChild(button);
      }

      const next = document.createElement("button");
      next.className = "page-button";
      next.type = "button";
      next.setAttribute("aria-label", "下一页");
      next.disabled = currentPage === totalPages;
      next.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
      next.addEventListener(
        "click",
        () => {
          if (currentPage < totalPages) {
            currentPage += 1;
            renderTable();
          }
        },
        { signal }
      );
      fragment.appendChild(next);
      pagination.replaceChildren(fragment);
      pagination.hidden = models.length <= PAGE_SIZE;
    }

    function renderTable() {
      const totalPages = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
      currentPage = Math.min(Math.max(currentPage, 1), totalPages);
      const startIndex = (currentPage - 1) * PAGE_SIZE;
      const pageModels = models.slice(startIndex, startIndex + PAGE_SIZE);
      pageModelIds = pageModels.map((model) => model.id);

      tableBody.innerHTML = pageModels
        .map((model) => {
          const isSelected = selectedIds.has(model.id);
          return `
            <tr class="${isSelected ? "is-selected" : ""}" data-model-id="${model.id}">
              <td>
                <label class="checkbox-wrap">
                  <span class="sr-only">选择 ${escapeHtml(model.model)}</span>
                  <input class="table-check row-check" type="checkbox" value="${model.id}" ${isSelected ? "checked" : ""}>
                </label>
              </td>
              <td>
                <a class="platform-cell" href="${escapeHtml(model.platformUrl)}" target="_blank" rel="noreferrer" title="打开 ${escapeHtml(model.platform)} 官网">
                  <span class="platform-mark ${model.darkMark ? "platform-mark--dark" : ""}">${escapeHtml(model.initials || initialsFor(model.platform))}</span>
                  <span>${escapeHtml(model.platform)}</span>
                </a>
              </td>
              <td>
                <a class="model-cell" href="${escapeHtml(model.modelUrl)}" target="_blank" rel="noreferrer" title="打开 ${escapeHtml(model.model)} 页面">
                  <span class="model-cell__text">${escapeHtml(model.model)}</span>
                </a>
              </td>
              <td><span class="type-badge">${escapeHtml(model.type)}</span></td>
              <td>
                <span class="cost">
                  <strong>${formatCost(model.inputCost)}</strong>
                  <span>/ ${escapeHtml(model.unit || "百万")}</span>
                </span>
              </td>
              <td>
                <span class="cost">
                  <strong>${formatCost(model.outputCost)}</strong>
                  <span>/ ${escapeHtml(model.unit || "百万")}</span>
                </span>
              </td>
            </tr>
          `;
        })
        .join("");

      const hasRows = pageModels.length > 0;
      emptyState.hidden = hasRows;
      tableScroll.hidden = !hasRows;

      const allVisibleSelected =
        hasRows && pageModels.every((model) => selectedIds.has(model.id));
      const someVisibleSelected =
        hasRows && pageModels.some((model) => selectedIds.has(model.id));
      selectAll.checked = allVisibleSelected;
      selectAll.indeterminate = someVisibleSelected && !allVisibleSelected;

      const selectedTotal = selectedIds.size;
      selectedCount.textContent = selectedTotal
        ? `已选择 ${selectedTotal} 项`
        : "未选择";
      selectedCount.classList.toggle("has-selection", selectedTotal > 0);
      editButton.disabled = selectedTotal !== 1;
      deleteButton.disabled = selectedTotal === 0;
      totalCount.textContent = `共 ${models.length} 个模型`;
      footerCount.textContent = hasRows
        ? `显示 ${startIndex + 1}-${startIndex + pageModels.length} 条，共 ${models.length} 条`
        : "显示 0 条记录";
      renderPagination(totalPages);
    }

    function parseOptionalNumber(input) {
      const value = input.value.trim();
      if (!value) {
        return { value: null, valid: true };
      }
      const number = Number(value);
      return {
        value: Number.isFinite(number) && number >= 0 ? number : null,
        valid: Number.isFinite(number) && number >= 0,
      };
    }

    function readCostFilters() {
      const parsed = {
        inputMin: parseOptionalNumber(inputCostMin),
        inputMax: parseOptionalNumber(inputCostMax),
        outputMin: parseOptionalNumber(outputCostMin),
        outputMax: parseOptionalNumber(outputCostMax),
      };

      if (Object.values(parsed).some((item) => !item.valid)) {
        showToast("费用区间请输入大于或等于 0 的数字");
        return null;
      }

      return {
        input_min: parsed.inputMin.value,
        input_max: parsed.inputMax.value,
        output_min: parsed.outputMin.value,
        output_max: parsed.outputMax.value,
      };
    }

    function closeModal(modal) {
      modal.hidden = true;
      closeAllCombos();
      if (addModal.hidden && deleteModal.hidden && editModal.hidden) {
        document.body.style.overflow = "";
        document.body.style.overflowY = "auto";
      }
    }

    function openModal(modal) {
      modal.hidden = false;
      document.body.style.overflow = "hidden";
      const focusTarget = modal.querySelector("input, button");
      window.setTimeout(() => focusTarget?.focus(), 0);
    }

    populateServerSelect(
      document.getElementById("editServerInput"),
      serverOptions
    );

    function openEditModal() {
      if (selectedIds.size !== 1) {
        return;
      }

      const model = models.find((item) => selectedIds.has(item.id));
      if (!model) {
        return;
      }

      editModelForm.elements.id.value = String(model.id);
      editModelForm.elements.srv_id.value = String(model.srvId);
      editModelForm.elements.mdl_name.value = model.model;
      editModelForm.elements.in_tok_fee.value = String(model.inputCost ?? "");
      editModelForm.elements.out_tok_fee.value = String(model.outputCost ?? "");
      editModelForm.elements.unit.value = model.unit || "百万";
      editModelForm.elements.mdl_type.value = model.rawType;
      editModelForm.elements.url.value =
        model.modelUrl === "#" ? "" : model.modelUrl;
      openModal(editModal);
    }

    renderTable();

    searchForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        closeAllCombos();
        const costFilters = readCostFilters();
        if (!costFilters) {
          return;
        }
        sendAction({
          action: "search_models",
          filters: {
            platform: searchPlatformInput.value,
            type: searchTypeInput.value,
            model: modelSearchInput.value,
            ...costFilters,
          },
        });
      },
      { signal }
    );

    resetButton.addEventListener(
      "click",
      () => {
        searchForm.reset();
        closeAllCombos();
        sendAction({
          action: "search_models",
          filters: {
            platform: "",
            type: "",
            model: "",
            input_min: null,
            input_max: null,
            output_min: null,
            output_max: null,
          },
        });
      },
      { signal }
    );

    refreshButton.addEventListener(
      "click",
      (event) => {
        const icon = event.currentTarget.querySelector("svg");
        icon?.animate(
          [
            { transform: "rotate(0deg)" },
            { transform: "rotate(360deg)" },
          ],
          { duration: 480, easing: "ease-out" }
        );
        const costFilters = readCostFilters();
        if (!costFilters) {
          return;
        }
        sendAction({
          action: "search_models",
          filters: {
            platform: searchPlatformInput.value,
            type: searchTypeInput.value,
            model: modelSearchInput.value,
            ...costFilters,
          },
          refresh: true,
        });
      },
      { signal }
    );

    selectAll.addEventListener(
      "change",
      () => {
        pageModelIds.forEach((modelId) => {
          if (selectAll.checked) {
            selectedIds.add(modelId);
          } else {
            selectedIds.delete(modelId);
          }
        });
        renderTable();
      },
      { signal }
    );

    tableBody.addEventListener(
      "change",
      (event) => {
        if (!event.target.classList.contains("row-check")) {
          return;
        }
        const modelId = Number(event.target.value);
        if (event.target.checked) {
          selectedIds.add(modelId);
        } else {
          selectedIds.delete(modelId);
        }
        renderTable();
      },
      { signal }
    );

    deleteButton.addEventListener(
      "click",
      () => {
        deleteConfirmCopy.innerHTML = `将删除 <strong>${selectedIds.size}</strong> 个模型配置，此操作无法撤销。`;
        openModal(deleteModal);
      },
      { signal }
    );

    editButton.addEventListener("click", openEditModal, { signal });

    confirmDeleteButton.addEventListener(
      "click",
      () => {
        confirmDeleteButton.disabled = true;
        sendAction({ action: "delete_models", ids: [...selectedIds] });
      },
      { signal }
    );

    editModelForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        sendAction({
          action: "update_model",
          id: Number(editModelForm.elements.id.value),
          srv_id: Number(editModelForm.elements.srv_id.value),
          mdl_name: editModelForm.elements.mdl_name.value.trim(),
          in_tok_fee: editModelForm.elements.in_tok_fee.value.trim(),
          out_tok_fee: editModelForm.elements.out_tok_fee.value.trim(),
          unit: editModelForm.elements.unit.value,
          mdl_type: editModelForm.elements.mdl_type.value.trim(),
          url: editModelForm.elements.url.value.trim(),
        });
      },
      { signal }
    );

    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener(
        "click",
        () => closeModal(document.getElementById(button.dataset.closeModal)),
        { signal }
      );
    });

    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener(
        "mousedown",
        (event) => {
          if (event.target === backdrop) {
            closeModal(backdrop);
          }
        },
        { signal }
      );
    });

    addModelForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        closeAllCombos();

        const formData = new FormData(addModelForm);
        const platform = String(formData.get("platform") || "").trim();
        const type = String(formData.get("type") || "").trim();
        const modelName = String(formData.get("model") || "").trim();
        const inputCostValue = String(formData.get("inputCost") || "").trim();
        const outputCostValue = String(formData.get("outputCost") || "").trim();
        const inputCostNumber = Number(inputCostValue);
        const outputCostNumber = Number(outputCostValue);
        const server = serverOptions.find(
          (item) => String(item.plat_name) === platform
        );

        if (!platform || !type || !modelName || !inputCostValue || !outputCostValue) {
          showToast("请先完善模型信息");
          return;
        }

        if (
          !Number.isFinite(inputCostNumber) ||
          inputCostNumber < 0 ||
          !Number.isFinite(outputCostNumber) ||
          outputCostNumber < 0
        ) {
          showToast("Token 费用请输入大于或等于 0 的数字");
          return;
        }

        if (!server) {
          showToast("请选择已配置的服务器");
          return;
        }

        sendAction({
          action: "create_model",
          srv_id: Number(server.id),
          mdl_name: modelName,
          in_tok_fee: inputCostNumber,
          out_tok_fee: outputCostNumber,
          unit: "百万",
          mdl_type: type,
          url: "",
        });
      },
      { signal }
    );

    document.addEventListener(
      "mousedown",
      (event) => {
        if (!event.target.closest(".combo")) {
          closeAllCombos();
        }
      },
      { signal }
    );

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") {
          return;
        }
        if (!deleteModal.hidden) {
          closeModal(deleteModal);
        } else if (!addModal.hidden) {
          closeModal(addModal);
        } else if (!editModal.hidden) {
          closeModal(editModal);
        }
      },
      { signal }
    );

    bindNavigation();
  }

  function promptUnitDivisor(unit) {
    const divisors = {
      K: 1000,
      万: 10000,
      十万: 100000,
      百万: 1000000,
    };
    return divisors[unit] || 1000000;
  }

  function renderPromptDis(args) {
    const serverData = (args.server_options || []).map((server) => ({
      id: Number(server.id),
      name: server.plat_name,
      company: server.co_name,
      baseUrl: server.base_url,
    }));
    const modelData = (args.models || []).map((model) => ({
      id: Number(model.id),
      serverId: Number(model.srv_id),
      platform: model.plat_name,
      name: model.mdl_name,
      type: String(model.mdl_type || "").replaceAll(",", "、"),
      inputPrice: model.in_tok_fee ?? 0,
      outputPrice: model.out_tok_fee ?? 0,
      unit: model.unit || "百万",
    }));
    const editContext = readEditContext();
    const editingResult = editContext?.type === "result"
      ? evaluationResults().find((item) => item.id === editContext.resultId)
      : null;
    const editingPlan = editContext?.type === "plan" || editingResult
      ? evaluationPlans().find((plan) => plan.id === (editContext.planId || editingResult?.planId))
        || evaluationPlans().find((plan) => plan.name === editingResult?.planName)
        || editingResult?.planSnapshot
        || (editingResult ? evaluationPlans()[0] : null)
      : null;
    if (editingPlan && !serverData.some((server) => server.name === editingPlan.server)) {
      serverData.push({ id: -1, name: editingPlan.server, company: editingPlan.server, baseUrl: "" });
    }
    const editServer = serverData.find((server) => server.name === editingPlan?.server);
    if (editingPlan && editServer && !modelData.some((model) => model.name === editingPlan.model && model.serverId === editServer.id)) {
      modelData.push({ id: -1, serverId: editServer.id, platform: editServer.name, name: editingPlan.model, type: "", inputPrice: 0, outputPrice: 0, unit: "百万" });
    }
    const signal = bridge.controller.signal;

    const serverSelect = document.getElementById("serverSelect");
    const modelSelect = document.getElementById("modelSelect");
    const baseUrlInput = document.getElementById("baseUrlInput");
    const apiKeyInput = document.getElementById("apiKeyInput");
    const passwordToggle = document.getElementById("passwordToggle");
    const serverCompanyLabel = document.getElementById("serverCompanyLabel");
    const serverError = document.getElementById("serverError");
    const apiKeyError = document.getElementById("apiKeyError");
    const modelError = document.getElementById("modelError");
    const priceTags = document.getElementById("priceTags");
    const inputPriceTag = document.getElementById("inputPriceTag");
    const outputPriceTag = document.getElementById("outputPriceTag");
    const systemPromptInput = document.getElementById("systemPromptInput");
    const systemPromptCopyButton = document.getElementById(
      "systemPromptCopyButton"
    );
    const systemPromptError = document.getElementById("systemPromptError");
    const userPromptInput = document.getElementById("userPromptInput");
    const planNameInput = document.getElementById("planNameInput");
    const resultEditFields = document.getElementById("resultEditFields");
    const resultQuestionInput = document.getElementById("resultQuestionInput");
    const resultExpectedInput = document.getElementById("resultExpectedInput");
    const userPromptError = document.getElementById("userPromptError");
    const round2Field = document.getElementById("round2Field");
    const round3Field = document.getElementById("round3Field");
    const round4Field = document.getElementById("round4Field");
    const multiTurnToggle = document.getElementById("multiTurnToggle");
    const roundsContainer = document.getElementById("roundsContainer");
    const addRoundButton = document.getElementById("addRoundButton");
    const roundLimitLabel = document.getElementById("roundLimitLabel");
    const roundCountLabel = document.getElementById("roundCountLabel");
    const debugForm = document.getElementById("debugForm");
    const debugButton = document.getElementById("debugButton");
    const resetButton = document.getElementById("resetButton");
    const saveEvalPlanButton = document.getElementById(
      "saveEvalPlanButton"
    );
    const currentModelName = document.getElementById("currentModelName");
    const responseStatus = document.getElementById("responseStatus");
    const responseTime = document.getElementById("responseTime");
    const modelOutput = document.getElementById("modelOutput");
    const outputMeta = document.getElementById("outputMeta");
    const copyButton = document.getElementById("copyButton");
    const clearOutputButton = document.getElementById("clearOutputButton");
    const inputTokenValue = document.getElementById("inputTokenValue");
    const outputTokenValue = document.getElementById("outputTokenValue");
    const totalTokenValue = document.getElementById("totalTokenValue");
    const inputCostMetric = document.getElementById("inputCostMetric");
    const outputCostMetric = document.getElementById("outputCostMetric");
    const totalCostMetric = document.getElementById("totalCostMetric");
    const pageStatusText = document.getElementById("pageStatusText");

    let selectedModel = null;
    let latestResult = "";
    let startedAt = 0;
    let isLoading = false;
    let visibleRounds = 2;

    function formatPrice(value, unit) {
      return `${formatUnitPrice(value)} / ${unit || "百万"}`;
    }

    function formatCurrency(value) {
      return `¥${decimalText(value)}`;
    }

    function formatInteger(value) {
      return new Intl.NumberFormat("zh-CN").format(Math.round(value));
    }

    function getSelectedServer() {
      return (
        serverData.find(
          (server) => String(server.id) === serverSelect.value
        ) || null
      );
    }

    function getSelectedModel() {
      return (
        modelData.find((model) => String(model.id) === modelSelect.value) ||
        null
      );
    }

    function populateServers() {
      const fragment = document.createDocumentFragment();
      serverData.forEach((server) => {
        const option = document.createElement("option");
        option.value = String(server.id);
        option.textContent = `${server.name} · ${server.company}`;
        fragment.appendChild(option);
      });
      serverSelect.replaceChildren(fragment);
    }

    function populateModels() {
      const server = getSelectedServer();
      const models = server
        ? modelData.filter((model) => model.serverId === server.id)
        : [];
      const fragment = document.createDocumentFragment();

      models.forEach((model) => {
        const option = document.createElement("option");
        option.value = String(model.id);
        option.textContent = model.type
          ? `${model.name} · ${model.type}`
          : model.name;
        fragment.appendChild(option);
      });

      modelSelect.replaceChildren(fragment);
      selectedModel = getSelectedModel();
    }

    function updateServerDetails() {
      const server = getSelectedServer();
      if (!server) {
        baseUrlInput.value = "";
        baseUrlInput.title = "";
        serverCompanyLabel.textContent = "请选择服务器";
        return;
      }

      baseUrlInput.value = server.baseUrl;
      serverCompanyLabel.textContent = server.company;
      baseUrlInput.title = server.baseUrl;
      serverError.textContent = "";
      serverSelect.removeAttribute("aria-invalid");
    }

    function updateModelDetails() {
      selectedModel = getSelectedModel();
      if (!selectedModel) {
        priceTags.hidden = true;
        currentModelName.textContent = "请选择模型";
        return;
      }

      inputPriceTag.textContent = formatPrice(
        selectedModel.inputPrice,
        selectedModel.unit
      );
      outputPriceTag.textContent = formatPrice(
        selectedModel.outputPrice,
        selectedModel.unit
      );
      priceTags.hidden = false;
      currentModelName.textContent = selectedModel.name;
      modelError.textContent = "";
      modelSelect.removeAttribute("aria-invalid");
      updateCostMetrics(0, 0, false);
    }

    function updateRoundUI() {
      const multiTurn = multiTurnToggle.checked;
      roundsContainer.hidden = !multiTurn;
      round2Field.hidden = !multiTurn;
      round3Field.hidden = !multiTurn || visibleRounds < 3;
      round4Field.hidden = !multiTurn || visibleRounds < 4;

      if (!multiTurn) {
        roundCountLabel.textContent = "单轮会话";
        return;
      }

      const nextRound = Math.min(visibleRounds + 1, 4);
      addRoundButton.hidden = visibleRounds >= 4;
      addRoundButton.querySelector("span").textContent = `添加第 ${nextRound} 轮`;
      roundLimitLabel.textContent =
        visibleRounds >= 4
          ? "已显示 4 轮，已达到上限"
          : `已显示 ${visibleRounds} 轮，最多支持 4 轮`;
      roundCountLabel.textContent = `多轮会话 · ${visibleRounds} 轮`;
    }

    function deleteRound(round) {
      if (isLoading) {
        showToast("调试中，暂时无法删除轮次");
        return;
      }

      const secondPrompt = document.getElementById("userPromptRound2");
      const thirdPrompt = document.getElementById("userPromptRound3");
      const fourthPrompt = document.getElementById("userPromptRound4");

      if (round === 2) {
        secondPrompt.value = "";
        thirdPrompt.value = "";
        fourthPrompt.value = "";
        multiTurnToggle.checked = false;
        visibleRounds = 2;
        updateRoundUI();
        showToast("已删除第二轮，并切换为单轮会话");
        return;
      }

      if (round === 3) {
        const hadFourthRound = visibleRounds >= 4;
        thirdPrompt.value = hadFourthRound ? fourthPrompt.value : "";
        fourthPrompt.value = "";
        visibleRounds = hadFourthRound ? 3 : 2;
        updateRoundUI();
        showToast(hadFourthRound ? "已删除第三轮，第四轮已前移" : "已删除第三轮");
        return;
      }

      if (round === 4) {
        fourthPrompt.value = "";
        visibleRounds = 3;
        updateRoundUI();
        showToast("已删除第四轮");
      }
    }

    function getRoundPrompts() {
      if (!multiTurnToggle.checked) {
        return [userPromptInput.value.trim()].filter(Boolean);
      }

      const prompts = [userPromptInput.value.trim()].filter(Boolean);
      document.querySelectorAll(".round-prompt").forEach((textarea) => {
        if (!textarea.closest("[hidden]") && textarea.value.trim()) {
          prompts.push(textarea.value.trim());
        }
      });
      return prompts;
    }

    function roundPromptFields() {
      const fields = [
        {
          input: userPromptInput,
          error: userPromptError,
          message: "请输入用户提示词",
        },
      ];

      if (multiTurnToggle.checked) {
        [
          [2, round2Field],
          [3, round3Field],
          [4, round4Field],
        ].forEach(([round, field]) => {
          if (field.hidden) {
            return;
          }
          fields.push({
            input: document.getElementById(`userPromptRound${round}`),
            error: document.getElementById(`userPromptRound${round}Error`),
            message: `请填写第 ${round} 轮用户提示词`,
          });
        });
      }

      return fields;
    }

    function updateSystemPromptCopyState() {
      systemPromptCopyButton.disabled = !systemPromptInput.value.trim();
    }

    function copyTextWithFallback(value) {
      const copyArea = document.createElement("textarea");
      copyArea.value = value;
      copyArea.setAttribute("readonly", "");
      copyArea.style.position = "fixed";
      copyArea.style.top = "0";
      copyArea.style.left = "-9999px";
      copyArea.style.opacity = "0";
      document.body.appendChild(copyArea);
      copyArea.focus();
      copyArea.select();
      copyArea.setSelectionRange(0, value.length);
      const copied = document.execCommand("copy");
      copyArea.remove();
      return copied;
    }

    async function copySystemPromptText() {
      const value = systemPromptInput.value;
      if (!value.trim()) {
        systemPromptError.textContent = "请先输入系统提示词";
        systemPromptInput.setAttribute("aria-invalid", "true");
        systemPromptInput.focus();
        showToast("系统提示词为空，无法复制");
        return;
      }

      if (copyTextWithFallback(value)) {
        showToast("系统提示词已复制");
        return;
      }

      try {
        await navigator.clipboard.writeText(value);
        showToast("系统提示词已复制");
      } catch {
        showToast("浏览器未允许复制，请手动复制");
      }
    }

    function validateForm() {
      let valid = true;
      const server = getSelectedServer();
      const key = apiKeyInput.value.trim();
      const systemPrompt = systemPromptInput.value.trim();

      serverError.textContent = "";
      apiKeyError.textContent = "";
      modelError.textContent = "";
      systemPromptError.textContent = "";
      userPromptError.textContent = "";
      serverSelect.removeAttribute("aria-invalid");
      apiKeyInput.removeAttribute("aria-invalid");
      modelSelect.removeAttribute("aria-invalid");
      systemPromptInput.removeAttribute("aria-invalid");
      userPromptInput.removeAttribute("aria-invalid");
      document
        .querySelectorAll(".round-prompt")
        .forEach((input) => input.removeAttribute("aria-invalid"));

      if (!server) {
        serverError.textContent = "请选择服务器";
        serverSelect.setAttribute("aria-invalid", "true");
        valid = false;
      }

      if (!key) {
        apiKeyError.textContent = "API Key 为必填项";
        apiKeyInput.setAttribute("aria-invalid", "true");
        valid = false;
      }

      if (!getSelectedModel()) {
        modelError.textContent = "请选择模型";
        modelSelect.setAttribute("aria-invalid", "true");
        valid = false;
      }

      if (!systemPrompt) {
        systemPromptError.textContent = "系统提示词为必填项";
        systemPromptInput.setAttribute("aria-invalid", "true");
        valid = false;
      }

      roundPromptFields().forEach(({ input, error, message }) => {
        if (error) {
          error.textContent = "";
        }
        if (!input.value.trim()) {
          if (error) {
            error.textContent = message;
          }
          input.setAttribute("aria-invalid", "true");
          valid = false;
        }
      });

      if (!valid) {
        const firstInvalid = document.querySelector('[aria-invalid="true"]');
        firstInvalid?.focus();
      }

      return valid;
    }

    function updateCostMetrics(inputTokens, outputTokens, reveal = true) {
      if (!selectedModel) {
        return;
      }

      const divisor = promptUnitDivisor(selectedModel.unit);
      const inputCost = tokenCost(
        inputTokens,
        selectedModel.inputPrice,
        divisor
      );
      const outputCost = tokenCost(
        outputTokens,
        selectedModel.outputPrice,
        divisor
      );
      const totalCost = addDecimalValues(inputCost, outputCost);

      inputCostMetric.textContent = formatCurrency(inputCost);
      outputCostMetric.textContent = formatCurrency(outputCost);
      totalCostMetric.textContent = formatCurrency(totalCost);

      inputTokenValue.textContent = reveal
        ? `${formatInteger(inputTokens)} tokens`
        : "0 tokens";
      outputTokenValue.textContent = reveal
        ? `${formatInteger(outputTokens)} tokens`
        : "0 tokens";
      totalTokenValue.textContent = reveal
        ? `${formatInteger(inputTokens + outputTokens)} tokens`
        : "0 tokens";
    }

    function setLoading(loading) {
      isLoading = loading;
      debugButton.disabled = loading;
      debugButton.querySelector("span").textContent = loading ? "调试中" : "调试";

      if (loading) {
        responseStatus.classList.add("is-loading");
        responseStatus.classList.remove("is-ready");
        responseStatus.textContent = "生成中";
        pageStatusText.textContent = "正在生成";
        startedAt = performance.now();
        window.clearInterval(bridge.elapsedTimer);
        bridge.elapsedTimer = window.setInterval(() => {
          responseTime.textContent = `${Math.round(
            performance.now() - startedAt
          )} ms`;
        }, 50);
      } else {
        window.clearInterval(bridge.elapsedTimer);
        bridge.elapsedTimer = null;
      }
    }

    function applyDebugResult(result) {
      if (!result || typeof result !== "object") {
        return;
      }

      const duration = Number(result.duration_ms || 0);
      responseTime.textContent = `${Math.round(duration)} ms`;

      if (result.status === "error") {
        const message = String(result.message || "模型调用失败");
        latestResult = "";
        modelOutput.value = `调用失败：${message}`;
        outputMeta.textContent = "调用失败";
        responseStatus.textContent = "调试失败";
        responseStatus.classList.remove("is-ready", "is-loading");
        pageStatusText.textContent = "调用失败";
        copyButton.disabled = true;
        clearOutputButton.disabled = false;
        updateCostMetrics(0, 0, false);
        showToast(message);
        return;
      }

      const output = String(result.output || "");
      if (!output) {
        modelOutput.value = "调用失败：模型未返回文本结果";
        outputMeta.textContent = "调用失败";
        responseStatus.textContent = "调试失败";
        responseStatus.classList.remove("is-ready", "is-loading");
        pageStatusText.textContent = "调用失败";
        copyButton.disabled = true;
        clearOutputButton.disabled = false;
        updateCostMetrics(0, 0, false);
        return;
      }

      const roundCount = Number(result.rounds || 0);
      latestResult = output;
      modelOutput.value = output;
      outputMeta.textContent = `${result.model_name || selectedModel?.name || "模型"} · ${roundCount} 轮`;
      responseStatus.textContent = "调试完成";
      responseStatus.classList.add("is-ready");
      responseStatus.classList.remove("is-loading");
      pageStatusText.textContent = "调试完成";
      copyButton.disabled = false;
      clearOutputButton.disabled = false;
      updateCostMetrics(
        Number(result.input_tokens || 0),
        Number(result.output_tokens || 0),
        true
      );
      showToast(`已使用 ${result.model_name || "模型"} 完成 ${roundCount} 轮调试`);
    }

    function runDebug() {
      if (isLoading || !validateForm()) {
        if (!isLoading) {
          showToast("请先完成必填配置");
        }
        return;
      }

      const server = getSelectedServer();
      const model = getSelectedModel();
      const rounds = getRoundPrompts();

      setLoading(true);
      responseTime.textContent = "0 ms";
      sendAction({
        action: "debug_model",
        server_id: server.id,
        model_id: model.id,
        api_key: apiKeyInput.value.trim(),
        system_prompt: systemPromptInput.value.trim(),
        prompts: rounds,
      });
    }

    function clearOutput() {
      latestResult = "";
      modelOutput.value = "";
      outputMeta.textContent = "等待结果";
      copyButton.disabled = true;
      clearOutputButton.disabled = true;
      responseStatus.textContent = "待调试";
      responseStatus.classList.remove("is-ready", "is-loading");
      responseTime.textContent = "0 ms";
      updateCostMetrics(0, 0, false);
    }

    function resetForm() {
      if (isLoading) {
        return;
      }

      apiKeyInput.value = "";
      apiKeyInput.type = "password";
      passwordToggle.setAttribute("aria-pressed", "false");
      passwordToggle.setAttribute("aria-label", "显示 API Key");
      multiTurnToggle.checked = false;
      visibleRounds = 2;
      round3Field.hidden = true;
      round4Field.hidden = true;
      systemPromptInput.value = "";
      updateSystemPromptCopyState();
      userPromptInput.value = "";
      document.querySelectorAll(".round-prompt").forEach((textarea) => {
        textarea.value = "";
      });
      updateRoundUI();
      clearOutput();
      updateCostMetrics(0, 0, false);
      apiKeyError.textContent = "";
      serverError.textContent = "";
      modelError.textContent = "";
      systemPromptError.textContent = "";
      userPromptError.textContent = "";
      apiKeyInput.removeAttribute("aria-invalid");
      serverSelect.removeAttribute("aria-invalid");
      modelSelect.removeAttribute("aria-invalid");
      systemPromptInput.removeAttribute("aria-invalid");
      userPromptInput.removeAttribute("aria-invalid");
      document
        .querySelectorAll(".round-prompt")
        .forEach((input) => input.removeAttribute("aria-invalid"));
      pageStatusText.textContent = "等待配置";
      responseStatus.textContent = "待调试";
      responseStatus.classList.remove("is-ready", "is-loading");
      responseTime.textContent = "0 ms";
      showToast("调试输入已重置");
    }

    populateServers();
    if (serverData.length) {
      serverSelect.value = String(serverData[0].id);
    }
    updateServerDetails();
    populateModels();
    updateModelDetails();
    updateRoundUI();
    updateSystemPromptCopyState();
    clearOutput();
    setLoading(false);
    applyDebugResult(args.debug_result);
    if (editingPlan) {
      const server = serverData.find((item) => item.name === editingPlan.server);
      if (server) {
        serverSelect.value = String(server.id);
        updateServerDetails();
        populateModels();
        const model = modelData.find((item) => item.serverId === server.id && item.name === editingPlan.model);
        if (model) modelSelect.value = String(model.id);
        updateModelDetails();
      }
      planNameInput.value = editingPlan.name || "";
      systemPromptInput.value = editingPlan.systemPrompt || "";
      userPromptInput.value = editingPlan.userPrompt || "";
      const savedPrompts = editingPlan.userPrompts || [editingPlan.userPrompt || ""];
      multiTurnToggle.checked = savedPrompts.length > 1;
      visibleRounds = Math.max(2, Math.min(savedPrompts.length, 4));
      for (let round = 2; round <= 4; round += 1) {
        document.getElementById(`userPromptRound${round}`).value = savedPrompts[round - 1] || "";
      }
      updateRoundUI();
      updateSystemPromptCopyState();
    }
    if (editingResult) {
      resultEditFields.hidden = false;
      resultQuestionInput.value = editingResult.question || "";
      resultExpectedInput.value = editingResult.expected || "";
      if (!editingPlan) planNameInput.value = editingResult.planName || "";
    }

    serverSelect.addEventListener(
      "change",
      () => {
        const previousServerId = selectedModel?.serverId;
        updateServerDetails();
        populateModels();

        if (previousServerId && previousServerId !== getSelectedServer()?.id) {
          showToast(`已切换至 ${getSelectedServer()?.name || "服务器"}`);
        }

        updateModelDetails();
        clearOutput();
      },
      { signal }
    );

    modelSelect.addEventListener(
      "change",
      () => {
        updateModelDetails();
        clearOutput();
      },
      { signal }
    );

    passwordToggle.addEventListener(
      "click",
      () => {
        const isVisible = apiKeyInput.type === "text";
        apiKeyInput.type = isVisible ? "password" : "text";
        passwordToggle.setAttribute("aria-pressed", String(!isVisible));
        passwordToggle.setAttribute(
          "aria-label",
          isVisible ? "显示 API Key" : "隐藏 API Key"
        );
        apiKeyInput.focus();
      },
      { signal }
    );

    apiKeyInput.addEventListener(
      "input",
      () => {
        if (apiKeyInput.value.trim()) {
          apiKeyError.textContent = "";
          apiKeyInput.removeAttribute("aria-invalid");
        }
      },
      { signal }
    );

    systemPromptInput.addEventListener(
      "input",
      () => {
        updateSystemPromptCopyState();
        if (systemPromptInput.value.trim()) {
          systemPromptError.textContent = "";
          systemPromptInput.removeAttribute("aria-invalid");
        }
      },
      { signal }
    );

    userPromptInput.addEventListener(
      "input",
      () => {
        if (userPromptInput.value.trim()) {
          userPromptError.textContent = "";
          userPromptInput.removeAttribute("aria-invalid");
        }
      },
      { signal }
    );

    document.querySelectorAll(".round-prompt").forEach((input) => {
      input.addEventListener(
        "input",
        () => {
          if (input.value.trim()) {
            const error = document.getElementById(`${input.id}Error`);
            if (error) {
              error.textContent = "";
            }
            input.removeAttribute("aria-invalid");
          }
        },
        { signal }
      );
    });

    systemPromptCopyButton.addEventListener("click", copySystemPromptText, {
      signal,
    });

    multiTurnToggle.addEventListener(
      "change",
      () => {
        if (!multiTurnToggle.checked) {
          visibleRounds = 2;
          round3Field.hidden = true;
          round4Field.hidden = true;
          document.getElementById("userPromptRound3").value = "";
          document.getElementById("userPromptRound4").value = "";
        }
        updateRoundUI();
      },
      { signal }
    );

    addRoundButton.addEventListener(
      "click",
      () => {
        if (visibleRounds >= 4) {
          showToast("最多支持 4 轮会话");
          return;
        }

        visibleRounds += 1;
        updateRoundUI();
        const target =
          visibleRounds === 3
            ? document.getElementById("userPromptRound3")
            : document.getElementById("userPromptRound4");
        target.focus();
        showToast(`已添加第 ${visibleRounds} 轮用户提示词`);
      },
      { signal }
    );

    document.querySelectorAll("[data-delete-round]").forEach((button) => {
      button.addEventListener(
        "click",
        () => deleteRound(Number(button.dataset.deleteRound)),
        { signal }
      );
    });

    debugForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        runDebug();
      },
      { signal }
    );

    resetButton.addEventListener("click", resetForm, { signal });

    saveEvalPlanButton.addEventListener(
      "click",
      () => {
        const server = getSelectedServer();
        const model = getSelectedModel();
        const systemPrompt = systemPromptInput.value.trim();
        const userPrompt = userPromptInput.value.trim();

        if (!server || !model) {
          showToast("请先选择服务器和模型");
          return;
        }

        if (!systemPrompt || !userPrompt) {
          showToast("请先填写系统提示词和用户提示词");
          return;
        }

        const question = resultQuestionInput.value.trim();
        const expected = resultExpectedInput.value.trim();
        if (editingResult && (!question || !expected)) {
          showToast("请填写问题和标准答案");
          (!question ? resultQuestionInput : resultExpectedInput).focus();
          return;
        }

        const savedPlans = evaluationPlans();
        const planName = planNameInput.value.trim() || `${model.name} · ${userPrompt.slice(0, 14)}`;
        const duplicateIndex = savedPlans.findIndex(
          (plan) =>
            plan.server === server.name &&
            plan.model === model.name &&
            plan.systemPrompt === systemPrompt &&
            plan.userPrompt === userPrompt
        );
        const plan = {
          id:
            editingPlan?.id || (duplicateIndex >= 0
              ? savedPlans[duplicateIndex].id
              : `plan-${Date.now()}`),
          name: planName,
          server: server.name,
          model: model.name,
          systemPrompt,
          userPrompt,
        };

        const planChanged = editingPlan && ["name", "server", "model", "systemPrompt", "userPrompt"]
          .some((field) => editingPlan[field] !== plan[field]);
        const rowChanged = editingResult && (question !== editingResult.question || expected !== editingResult.expected);
        if (planChanged || editingResult) {
          const storedResults = evaluationResults();
          const updatedResults = storedResults.map((item) => {
            const isEditedRow = editingResult && item.id === editingResult.id;
            const belongsToPlan = editingPlan && (item.planId === editingPlan.id || item.planName === editingPlan.name);
            if (!isEditedRow && !belongsToPlan) return item;
            return {
              ...item,
              planId: plan.id,
              planName: plan.name,
              planSnapshot: { ...plan },
              question: isEditedRow ? question : item.question,
              expected: isEditedRow ? expected : item.expected,
              needsRerun: item.needsRerun || Boolean(planChanged) || Boolean(isEditedRow && rowChanged),
            };
          });
          if (!writeStorageJson(EVAL_RESULTS_KEY, updatedResults)) {
            showToast("方案已保存，但评测数据更新失败");
            return;
          }
          if (editingResult) {
            const state = readStorageJson(EVAL_STATE_KEY, null);
            const row = state?.rows?.find((item) => item.resultId === editingResult.id);
            if (row) {
              row.question = question;
              row.expected = expected;
              writeStorageJson(EVAL_STATE_KEY, state);
            }
          }
        }
        try { window.sessionStorage.removeItem(EDIT_CONTEXT_KEY); } catch { /* Storage may be disabled. */ }
        const userPrompts = [userPrompt];
        if (multiTurnToggle.checked) {
          for (let round = 2; round <= visibleRounds; round += 1) {
            userPrompts.push(document.getElementById(`userPromptRound${round}`).value.trim());
          }
        }
        sendAction({
          action: "save_prompt",
          prompt_id: editingPlan?.dbId || null,
          prompt_name: planName,
          model_id: model.id,
          api_key: apiKeyInput.value.trim(),
          sys_prompt: systemPrompt,
          user_prompts: userPrompts,
          result_edit: editingResult && !standalonePage
            ? { id: editingResult.id, question, expected } : null,
        });
      },
      { signal }
    );

    copyButton.addEventListener(
      "click",
      async () => {
        if (!latestResult) {
          return;
        }

        try {
          await navigator.clipboard.writeText(latestResult);
          showToast("模型输出已复制");
        } catch {
          modelOutput.focus();
          modelOutput.select();
          document.execCommand("copy");
          showToast("模型输出已复制");
        }
      },
      { signal }
    );

    clearOutputButton.addEventListener(
      "click",
      () => {
        clearOutput();
        showToast("输出与费用指标已清空");
      },
      { signal }
    );

    bindNavigation();
  }

  function renderPromptList() {
    const signal = bridge.controller.signal;
    const plans = standalonePage ? evaluationPlans() : databasePlans();
    const $ = (id) => document.getElementById(id);

    function renderList() {
      const query = $("promptSearch").value.trim().toLocaleLowerCase();
      const visible = plans.filter((plan) =>
        [plan.name, plan.server, plan.model, plan.systemPrompt]
          .some((value) => String(value || "").toLocaleLowerCase().includes(query))
      );
      $("promptListCount").textContent = `${plans.length} 个`;
      $("promptListEmpty").hidden = visible.length > 0;
      $("promptListBody").innerHTML = visible.map((plan) => {
        const prompt = Array.from(String(plan.systemPrompt || ""));
        const preview = prompt.slice(0, 25).join("") + (prompt.length > 25 ? "…" : "");
        return `
        <tr><td><strong>${escapeHtml(plan.name)}</strong></td>
        <td>${escapeHtml(plan.server)}</td>
        <td>${escapeHtml(plan.model)}</td>
        <td><span class="cell-text">${escapeHtml(preview)}</span></td>
        <td><span class="prompt-list-actions"><button class="link-button" type="button" data-edit-plan="${escapeHtml(plan.id)}">编辑</button></span></td></tr>
      `;
      }).join("");
    }

    $("promptSearch").addEventListener("input", renderList, { signal });
    $("promptListBody").addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit-plan]");
      if (edit) {
        try {
          window.sessionStorage.setItem(EDIT_CONTEXT_KEY, JSON.stringify({ type: "plan", planId: edit.dataset.editPlan }));
          navigate("prompt_dis");
        } catch { showToast("无法打开提示词编辑，请检查浏览器存储权限"); }
      }
    }, { signal });
    renderList();
    bindNavigation();
  }

  function renderEvaluationResults() {
    const signal = bridge.controller.signal;
    let results = evaluationResults();
    let activeGroupKey = null;
    let groups = [];
    const $ = (id) => document.getElementById(id);
    const detailModal = $("resultDetailModal");

    function resultGroups() {
      const grouped = new Map();
      results.forEach((item) => {
        const planName = item.planName || "评测方案";
        const key = item.runId || `legacy:${planName}`;
        if (!grouped.has(key)) grouped.set(key, { key, planName, items: [] });
        grouped.get(key).items.push(item);
      });
      return [...grouped.values()];
    }

    function groupStats(group) {
      const total = group.items.length;
      const correct = group.items.filter((item) => item.judgment === "正确").length;
      const wrong = group.items.filter((item) => item.judgment === "错误").length;
      const latest = group.items.reduce((value, item) =>
        item.evaluatedAt > value ? item.evaluatedAt : value, "");
      return { total, correct, wrong, accuracy: total ? Math.round(correct / total * 100) : 0, latest };
    }

    function renderList() {
      const query = $("resultSearch").value.trim().toLocaleLowerCase();
      groups = resultGroups();
      const visible = groups.filter((group) =>
        [group.planName, ...group.items.flatMap((item) => [item.question, item.expected, item.modelOutput])]
          .some((value) => String(value || "").toLocaleLowerCase().includes(query))
      );
      $("resultCount").textContent = `${groups.length} 次评测`;
      $("resultListEmpty").hidden = visible.length > 0;
      $("resultTableScroll").hidden = visible.length === 0;
      $("resultListBody").innerHTML = visible.map((group) => {
        const stats = groupStats(group);
        const date = stats.latest ? new Date(stats.latest).toLocaleString("zh-CN") : "-";
        const firstQuestion = group.items[0]?.question || "-";
        return `<tr>
          <td>${escapeHtml(group.planName)}${group.items.some((item) => item.needsRerun) ? '<span class="result-meta">待重调</span>' : ""}</td>
          <td><span class="cell-text">${escapeHtml(firstQuestion)}</span>${stats.total > 1 ? `<span class="result-meta">等 ${stats.total} 个问题</span>` : ""}</td>
          <td>${stats.total}</td>
          <td>${stats.correct} / ${stats.wrong}</td>
          <td><span class="result-badge ${stats.accuracy >= 80 ? "result-badge--correct" : "result-badge--wrong"}">${stats.accuracy}%</span></td>
          <td>${escapeHtml(date)}</td>
          <td><span class="result-row-actions"><button class="link-button" type="button" data-view-group="${escapeHtml(group.key)}">查看</button><button class="link-button" type="button" data-rerun-group="${escapeHtml(group.key)}">重调</button></span></td>
        </tr>`;
      }).join("");
    }

    function renderDetails() {
      const group = resultGroups().find((item) => item.key === activeGroupKey);
      if (!group) { detailModal.hidden = true; activeGroupKey = null; return; }
      const stats = groupStats(group);
      $("resultDetailTitle").textContent = `${group.planName} · 评测详情`;
      $("resultDetailSummary").textContent = `${stats.total} 条测试 · 正确 ${stats.correct} 条 · 错误 ${stats.wrong} 条 · 准确率 ${stats.accuracy}%`;
      $("resultDetailBody").innerHTML = group.items.map((item) => `<tr>
        <td><span class="cell-text" title="${escapeHtml(item.question)}">${escapeHtml(previewThirtyCharacters(item.question))}</span></td>
        <td><span class="cell-text" title="${escapeHtml(item.expected)}">${escapeHtml(previewThirtyCharacters(item.expected))}</span></td>
        <td><span class="cell-text" title="${escapeHtml(item.modelOutput)}">${escapeHtml(previewThirtyCharacters(item.modelOutput))}</span></td>
        <td><span class="result-badge ${item.judgment === "正确" ? "result-badge--correct" : "result-badge--wrong"}">${escapeHtml(item.judgment)}</span></td>
        <td><span class="result-badge ${item.corrected ? "result-badge--yes" : ""}">${item.corrected ? "是" : "否"}</span></td>
        <td><span class="result-row-actions"><button class="link-button" type="button" data-edit-result="${escapeHtml(item.id)}">修改</button></span></td>
      </tr>`).join("");
    }

    function rerunGroup(key) {
      const group = resultGroups().find((item) => item.key === key);
      if (!group) return;
      if (!standalonePage) {
        writeStorageJson(EVAL_STATE_KEY, {
          selectedPlanId: group.items[0].planId,
          runId: `run-${Date.now()}`,
          autoStart: true,
          rows: group.items.map((item) => ({
            question: item.question, expected: item.expected,
            result: "", judgment: "待判定", corrected: false,
          })),
        });
        navigate("prompt_eval");
        return;
      }
      const pending = group.items.filter((item) => item.needsRerun);
      if (!pending.length) { showToast("当前评测没有待重调的修改"); return; }
      const pendingIds = new Set(pending.map((item) => item.id));
      const evaluatedAt = new Date().toISOString();
      const next = results.map((item) => {
        if (!pendingIds.has(item.id)) return item;
        const correct = item.judgment !== "正确";
        return { ...item,
          modelOutput: correct ? `${item.expected}（重调结果）` : "重调结果未覆盖标准答案中的关键信息。",
          judgment: correct ? "正确" : "错误",
          originalJudgment: correct ? "正确" : "错误",
          corrected: false,
          needsRerun: false,
          evaluatedAt,
        };
      });
      if (!writeStorageJson(EVAL_RESULTS_KEY, next)) { showToast("重调结果保存失败"); return; }
      results = next;
      const state = readStorageJson(EVAL_STATE_KEY, null);
      if (Array.isArray(state?.rows)) {
        const byId = new Map(next.map((item) => [item.id, item]));
        state.rows.forEach((row) => {
          const item = byId.get(row.resultId);
          if (!item) return;
          row.question = item.question;
          row.expected = item.expected;
          row.result = item.modelOutput;
          row.judgment = item.judgment;
          row.originalJudgment = item.originalJudgment;
          row.corrected = item.corrected;
        });
        writeStorageJson(EVAL_STATE_KEY, state);
      }
      renderList();
      if (activeGroupKey) renderDetails();
      showToast(`已重调 ${pending.length} 条数据，准确率已更新`);
    }

    $("resultSearch").addEventListener("input", renderList, { signal });
    $("resultListBody").addEventListener("click", (event) => {
      const rerun = event.target.closest("[data-rerun-group]");
      if (rerun) { rerunGroup(rerun.dataset.rerunGroup); return; }
      const button = event.target.closest("[data-view-group]");
      if (!button) return;
      activeGroupKey = button.dataset.viewGroup;
      renderDetails();
      detailModal.hidden = false;
      $("closeResultDetailTop").focus();
    }, { signal });
    $("resultDetailBody").addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit-result]");
      if (edit) {
        const item = results.find((result) => result.id === edit.dataset.editResult);
        if (!item) return;
        try {
          window.sessionStorage.setItem(EDIT_CONTEXT_KEY, JSON.stringify({ type: "result", resultId: item.id, planId: item.planId || "" }));
          navigate("prompt_dis");
        } catch { showToast("无法打开修改页面，请检查浏览器存储权限"); }
      }
    }, { signal });
    const closeDetails = () => { detailModal.hidden = true; activeGroupKey = null; };
    $("closeResultDetailTop").addEventListener("click", closeDetails, { signal });
    detailModal.addEventListener("click", (event) => { if (event.target === detailModal) closeDetails(); }, { signal });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !detailModal.hidden) closeDetails();
    }, { signal });
    renderList();
    bindNavigation();
  }

  function renderPromptEval() {
    const signal = bridge.controller.signal;
    evaluationResults();
    const defaultData = [
      { question: "用户说‘我想修改收货地址’，应归类为什么意图？", expected: "订单修改", result: "订单修改（样例模型输出）", judgment: "正确" },
      { question: "客户反馈商品破损，应优先转给哪个服务组？", expected: "售后服务", result: "售后服务（样例模型输出）", judgment: "正确" },
      { question: "用户询问如何补开发票，应识别为什么意图？", expected: "发票服务", result: "订单咨询（样例模型输出）", judgment: "错误" },
      { question: "用户无法登录时，应先检查哪些信息？", expected: "检查账号、密码、验证码及登录环境。", result: "", judgment: "待判定" },
      { question: "用户咨询退款进度，应先确认什么？", expected: "确认订单号、支付渠道及退款状态。", result: "", judgment: "待判定" },
    ];
    const savedState = readStorageJson(EVAL_STATE_KEY, null);
    const plans = evaluationPlans();
    let selectedPlanId = plans.some((plan) => plan.id === savedState?.selectedPlanId)
      ? savedState.selectedPlanId : plans[0]?.id || "";
    const latestSaved = (bridge.args.evaluations || []).filter(
      (item) => `db-${item.prompt_id}` === selectedPlanId
    );
    const latestRun = latestSaved[0]?.run_id;
    let rows = savedState?.selectedPlanId === selectedPlanId && Array.isArray(savedState.rows)
      ? savedState.rows
      : standalonePage ? defaultData : latestSaved
        .filter((item) => item.run_id === latestRun)
        .reverse().map((item) => ({
          resultId: String(item.id), question: item.question || "",
          expected: item.s_answer || "", result: item.m_answer || "",
          judgment: item.is_true === 1 ? "正确" : item.is_true === 0 ? "错误" : "待判定",
          corrected: item.is_correct === 1,
          needsRerun: item.needs_rerun === 1,
        }));
    let runId = savedState?.runId || latestRun || `run-${Date.now()}`;
    let currentPage = 1;
    let editingIndex = null;
    let pendingDeleteIndexes = [];
    let evaluating = false;
    const selectedIndexes = new Set();

    const planSelect = document.getElementById("evaluationPlanSelect");
    const planCountLabel = document.getElementById("planCountLabel");
    const summaryServer = document.getElementById("summaryServer");
    const summaryModel = document.getElementById("summaryModel");
    const summaryPrompt = document.getElementById("summaryPrompt");
    const systemPromptModal = document.getElementById("systemPromptModal");
    const systemPromptFullText = document.getElementById("systemPromptFullText");
    const showSystemPromptButton = document.getElementById("showSystemPromptButton");
    const saveButton = document.getElementById("saveEvaluationButton");
    const importButton = document.getElementById("importExcelButton");
    const manualButton = document.getElementById("manualEntryButton");
    const startButton = document.getElementById("startEvaluationButton");
    const exportButton = document.getElementById("exportResultsButton");
    const deleteSelectedButton = document.getElementById(
      "deleteSelectedButton"
    );
    const fileInput = document.getElementById("excelFileInput");
    const importModal = document.getElementById("importModal");
    const importForm = document.getElementById("importForm");
    const importError = document.getElementById("importError");
    const tableBody = document.getElementById("evaluationTableBody");
    const tableScroll = document.getElementById("dataTableScroll");
    const emptyState = document.getElementById("evaluationEmptyState");
    const selectAll = document.getElementById("selectAllData");
    const selectedCount = document.getElementById("selectedCount");
    const footerCount = document.getElementById("tableFooterCount");
    const pagination = document.getElementById("dataPagination");
    const metricTotal = document.getElementById("metricTotal");
    const metricCorrect = document.getElementById("metricCorrect");
    const metricAccuracy = document.getElementById("metricAccuracy");
    const metricCorrections = document.getElementById("metricCorrections");
    const evaluationStatus = document.getElementById("evaluationStatus");
    const progressLabel = document.getElementById("progressLabel");
    const progressValue = document.getElementById("progressValue");
    const progressBar = document.getElementById("progressBar");
    const progressTrack = document.getElementById("progressTrack");
    const progressHint = document.getElementById("progressHint");
    const entryModal = document.getElementById("entryModal");
    const entryForm = document.getElementById("entryForm");
    const entryModalTitle = document.getElementById("entryModalTitle");
    const entryQuestionInput = document.getElementById(
      "entryQuestionInput"
    );
    const entryQuestionError = document.getElementById(
      "entryQuestionError"
    );
    const entryAnswerInput = document.getElementById("entryAnswerInput");
    const entryAnswerError = document.getElementById("entryAnswerError");
    const deleteModal = document.getElementById("deleteModal");
    const deleteModalCopy = document.getElementById("deleteModalCopy");
    const confirmDeleteButton = document.getElementById(
      "confirmDeleteButton"
    );

    function selectedPlan() {
      return (
        plans.find((plan) => plan.id === selectedPlanId) || plans[0] || null
      );
    }

    function persistState() {
      return writeStorageJson(EVAL_STATE_KEY, {
        rows,
        selectedPlanId,
        runId,
        lastEvaluationToken: readStorageJson(EVAL_STATE_KEY, null)?.lastEvaluationToken,
        lastSaveToken: readStorageJson(EVAL_STATE_KEY, null)?.lastSaveToken,
      });
    }

    function archiveRows(forceNew = false) {
      const archived = evaluationResults();
      const additions = [];
      const previousValues = [];
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const evaluatedAt = new Date().toISOString();
      rows.forEach((row, index) => {
        if (!row.result || row.judgment === "待判定" || (!forceNew && row.resultId)) return;
        previousValues.push({ row, resultId: row.resultId, originalJudgment: row.originalJudgment, corrected: row.corrected });
        row.resultId = `result-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
        row.originalJudgment = row.judgment;
        row.corrected = false;
        additions.push({
          id: row.resultId,
          runId,
          question: row.question,
          expected: row.expected,
          modelOutput: row.result,
          judgment: row.judgment,
          originalJudgment: row.originalJudgment,
          corrected: false,
          planId: selectedPlan()?.id || "",
          planName: selectedPlan()?.name || "评测方案",
          planSnapshot: selectedPlan() ? { ...selectedPlan() } : null,
          evaluatedAt,
        });
      });
      if (!additions.length) return true;
      if (writeStorageJson(EVAL_RESULTS_KEY, [...additions, ...archived])) return true;
      previousValues.forEach(({ row, resultId, originalJudgment, corrected }) => {
        if (resultId === undefined) delete row.resultId; else row.resultId = resultId;
        if (originalJudgment === undefined) delete row.originalJudgment; else row.originalJudgment = originalJudgment;
        if (corrected === undefined) delete row.corrected; else row.corrected = corrected;
      });
      return false;
    }

    function populatePlans() {
      const fragment = document.createDocumentFragment();
      plans.forEach((plan) => {
        const option = document.createElement("option");
        option.value = plan.id;
        option.textContent = plan.name;
        fragment.appendChild(option);
      });
      planSelect.replaceChildren(fragment);
      if (!plans.some((plan) => plan.id === selectedPlanId)) {
        selectedPlanId = plans[0]?.id || "";
      }
      planSelect.value = selectedPlanId;
      planCountLabel.textContent = `${plans.length} 个`;
      updatePlanSummary();
    }

    function updatePlanSummary() {
      const plan = selectedPlan();
      summaryServer.textContent = plan?.server || "暂无可用方案";
      summaryModel.textContent = plan?.model || "-";
      summaryPrompt.textContent =
        plan?.systemPrompt || "请先到提示词调试页创建方案。";
      showSystemPromptButton.disabled = !plan?.systemPrompt;
    }

    function metrics() {
      const completed = rows.filter((row) => row.result && row.judgment !== "待判定");
      const evaluated = completed.length;
      const correct = completed.filter((row) => row.judgment === "正确").length;
      const corrections = completed.filter((row) => row.corrected === true).length;
      return {
        total: rows.length,
        evaluated,
        correct,
        corrections,
        accuracy: evaluated ? Math.round((correct / evaluated) * 100) : 0,
      };
    }

    function updateMetrics() {
      const value = metrics();
      metricTotal.textContent = String(value.evaluated);
      metricCorrect.textContent = String(value.correct);
      metricAccuracy.textContent = `${value.accuracy}%`;
      metricCorrections.textContent = String(value.corrections);

      const progress = value.total
        ? Math.round((value.evaluated / value.total) * 100)
        : 0;
      progressValue.textContent = `${value.evaluated} / ${value.total}`;
      progressBar.style.width = `${progress}%`;
      progressTrack.setAttribute("aria-valuenow", String(progress));
      if (!evaluating) {
        evaluationStatus.textContent = value.evaluated
          ? value.evaluated === value.total
            ? "评测完成"
            : "部分完成"
          : "待评测";
        progressLabel.textContent = value.evaluated
          ? "当前完成度"
          : "准备开始";
        progressHint.textContent = value.evaluated
          ? `已有 ${value.evaluated} 条生成模型结果`
          : "选择方案并准备测试数据";
      }
    }

    function renderPagination(totalPages) {
      const fragment = document.createDocumentFragment();
      const previous = document.createElement("button");
      previous.className = "page-button";
      previous.type = "button";
      previous.setAttribute("aria-label", "上一页");
      previous.disabled = currentPage === 1;
      previous.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>';
      previous.addEventListener(
        "click",
        () => {
          if (currentPage > 1) {
            currentPage -= 1;
            renderTable();
          }
        },
        { signal }
      );
      fragment.appendChild(previous);

      for (let page = 1; page <= totalPages; page += 1) {
        const button = document.createElement("button");
        button.className = `page-button${
          page === currentPage ? " is-current" : ""
        }`;
        button.type = "button";
        button.textContent = String(page);
        if (page === currentPage) {
          button.setAttribute("aria-current", "page");
        }
        button.addEventListener(
          "click",
          () => {
            currentPage = page;
            renderTable();
          },
          { signal }
        );
        fragment.appendChild(button);
      }

      const next = document.createElement("button");
      next.className = "page-button";
      next.type = "button";
      next.setAttribute("aria-label", "下一页");
      next.disabled = currentPage === totalPages;
      next.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
      next.addEventListener(
        "click",
        () => {
          if (currentPage < totalPages) {
            currentPage += 1;
            renderTable();
          }
        },
        { signal }
      );
      fragment.appendChild(next);
      pagination.replaceChildren(fragment);
      pagination.hidden = rows.length <= PAGE_SIZE;
    }

    function renderTable() {
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      currentPage = Math.min(Math.max(currentPage, 1), totalPages);
      const startIndex = (currentPage - 1) * PAGE_SIZE;
      const pageRows = rows
        .map((row, index) => ({ row, index }))
        .slice(startIndex, startIndex + PAGE_SIZE);

      tableBody.innerHTML = pageRows
        .map(({ row, index }) => {
          const checked = selectedIndexes.has(index);
          return `
            <tr class="${checked ? "is-selected" : ""}" data-row-index="${index}">
              <td>
                <label class="checkbox-wrap">
                  <span class="sr-only">选择第 ${index + 1} 条数据</span>
                  <input class="table-check row-check" type="checkbox" data-index="${index}" ${checked ? "checked" : ""}>
                </label>
              </td>
              <td>${index + 1}</td>
              <td><span class="cell-text" title="${escapeHtml(row.question)}">${escapeHtml(row.question)}</span></td>
              <td><span class="cell-text" title="${escapeHtml(row.expected)}">${escapeHtml(row.expected)}</span></td>
              <td><span class="cell-text ${row.result ? "" : "cell-text--muted"}" title="${escapeHtml(row.result || "尚未评测")}">${escapeHtml(row.result || "尚未评测")}</span></td>
              <td><label class="judgment-toggle"><input type="checkbox" class="judgment-switch" data-index="${index}" ${row.judgment === "正确" ? "checked" : ""} ${row.result && !evaluating ? "" : "disabled"} aria-label="第 ${index + 1} 条判定结果，开启为正确，关闭为错误"><span>${escapeHtml(row.judgment)}</span></label></td>
              <td><button class="link-button" type="button" data-delete-index="${index}" aria-label="删除第 ${index + 1} 条测试数据">删除</button></td>
            </tr>
          `;
        })
        .join("");

      const hasRows = pageRows.length > 0;
      tableScroll.hidden = !hasRows;
      emptyState.hidden = hasRows;

      const allVisibleSelected =
        hasRows &&
        pageRows.every(({ index }) => selectedIndexes.has(index));
      const someVisibleSelected =
        hasRows &&
        pageRows.some(({ index }) => selectedIndexes.has(index));
      selectAll.checked = allVisibleSelected;
      selectAll.indeterminate =
        someVisibleSelected && !allVisibleSelected;
      selectAll.disabled = !hasRows;

      selectedCount.textContent = selectedIndexes.size
        ? `已选择 ${selectedIndexes.size} 项`
        : "未选择";
      selectedCount.classList.toggle(
        "has-selection",
        selectedIndexes.size > 0
      );
      deleteSelectedButton.disabled = selectedIndexes.size === 0;
      exportButton.disabled = rows.length === 0;
      footerCount.textContent = hasRows
        ? `显示 ${startIndex + 1}-${startIndex + pageRows.length} 条，共 ${rows.length} 条`
        : "显示 0 条记录";
      renderPagination(totalPages);
      updateMetrics();
    }

    function openEntryModal(index = null) {
      editingIndex = index;
      const row = index === null ? null : rows[index];
      entryModalTitle.textContent = row
        ? "编辑测试数据"
        : "手动录入测试数据";
      entryQuestionInput.value = row?.question || "";
      entryAnswerInput.value = row?.expected || "";
      entryQuestionError.textContent = "";
      entryAnswerError.textContent = "";
      entryModal.hidden = false;
      window.setTimeout(() => entryQuestionInput.focus(), 0);
    }

    function closeEntryModal() {
      entryModal.hidden = true;
      editingIndex = null;
    }

    function openDeleteModal(indexes) {
      pendingDeleteIndexes = [...new Set(indexes)].filter(
        (index) => index >= 0 && index < rows.length
      );
      if (!pendingDeleteIndexes.length) {
        return;
      }
      deleteModalCopy.textContent =
        pendingDeleteIndexes.length === 1
          ? "将删除这条测试数据，此操作无法撤销。"
          : `将删除 ${pendingDeleteIndexes.length} 条测试数据，此操作无法撤销。`;
      deleteModal.hidden = false;
      window.setTimeout(() => confirmDeleteButton.focus(), 0);
    }

    function closeDeleteModal() {
      deleteModal.hidden = true;
      pendingDeleteIndexes = [];
    }

    function parseCsv(content) {
      const records = [];
      let record = [];
      let value = "";
      let quoted = false;
      for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        if (character === '"' && quoted && content[index + 1] === '"') {
          value += '"';
          index += 1;
        } else if (character === '"') {
          quoted = !quoted;
        } else if (character === "," && !quoted) {
          record.push(value.trim());
          value = "";
        } else if ((character === "\n" || character === "\r") && !quoted) {
          record.push(value.trim());
          if (record.some((cell) => cell)) records.push(record);
          record = [];
          value = "";
          if (character === "\r" && content[index + 1] === "\n") index += 1;
        } else {
          value += character;
        }
      }
      if (quoted) throw new Error("CSV 文件中的引号未闭合");
      record.push(value.trim());
      if (record.some((cell) => cell)) records.push(record);
      return records;
    }

    function handleImportedRows(importedRows, fileName) {
      if (!importedRows.length) {
        showToast("未读取到“问题”和“标准答案”数据");
        return;
      }

      const nextRows = [...importedRows, ...rows];
      if (!writeStorageJson(EVAL_STATE_KEY, { rows: nextRows, selectedPlanId })) {
        throw new Error("导入数据保存失败，请检查浏览器存储空间");
      }
      rows = nextRows;
      selectedIndexes.clear();
      currentPage = 1;
      renderTable();
      showToast(`已从 ${fileName} 导入 ${importedRows.length} 条数据`);
    }

    async function xlsxRows(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const view = new DataView(bytes.buffer);
      let directory = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
        if (view.getUint32(i, true) === 0x06054b50) { directory = view.getUint32(i + 16, true); break; }
      }
      if (directory < 0) throw new Error("无效的 Excel 文件");
      const files = new Map();
      while (directory + 46 <= bytes.length && view.getUint32(directory, true) === 0x02014b50) {
        const nameLength = view.getUint16(directory + 28, true);
        const extraLength = view.getUint16(directory + 30, true);
        const commentLength = view.getUint16(directory + 32, true);
        const name = new TextDecoder().decode(bytes.slice(directory + 46, directory + 46 + nameLength));
        files.set(name, { method: view.getUint16(directory + 10, true), size: view.getUint32(directory + 20, true), offset: view.getUint32(directory + 42, true) });
        directory += 46 + nameLength + extraLength + commentLength;
      }
      async function xmlFile(name) {
        const item = files.get(name);
        if (!item) return null;
        const offset = item.offset;
        if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("Excel 文件结构无效");
        const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
        const chunk = bytes.slice(start, start + item.size);
        let data = chunk;
        if (item.method === 8) {
          if (!window.DecompressionStream) throw new Error("当前浏览器不支持读取压缩 Excel，请使用 CSV 文件");
          data = new Uint8Array(await new Response(new Blob([chunk]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
        } else if (item.method !== 0) throw new Error("不支持此 Excel 压缩格式");
        const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("Excel 工作表解析失败");
        return doc;
      }
      const sharedDoc = await xmlFile("xl/sharedStrings.xml");
      const shared = sharedDoc ? [...sharedDoc.getElementsByTagName("si")].map((item) => [...item.getElementsByTagName("t")].map((t) => t.textContent).join("")) : [];
      const sheetName = [...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0];
      if (!sheetName) throw new Error("Excel 文件没有可读取的工作表");
      const sheet = await xmlFile(sheetName);
      return [...sheet.getElementsByTagName("row")].map((row) => {
        const values = [];
        for (const cell of row.getElementsByTagName("c")) {
          const ref = cell.getAttribute("r") || "A1";
          let column = 0;
          for (const letter of (ref.match(/^[A-Z]+/)?.[0] || "A")) column = column * 26 + letter.charCodeAt(0) - 64;
          const raw = cell.getElementsByTagName("v")[0]?.textContent || "";
          values[column - 1] = cell.getAttribute("t") === "s" ? shared[Number(raw)] || "" : cell.getAttribute("t") === "inlineStr" ? [...cell.getElementsByTagName("t")].map((t) => t.textContent).join("") : raw;
        }
        return values;
      });
    }

    async function importFile(file) {
      if (!file) throw new Error("请选择 Excel 文件");
      const parsed = /\.csv$/i.test(file.name)
        ? parseCsv((await file.text()).replace(/^\ufeff/, ""))
        : /\.xlsx$/i.test(file.name) ? await xlsxRows(file) : (() => { throw new Error("请选择 .xlsx 或 .csv 文件"); })();
      if (!parsed.length) throw new Error("文件中没有数据");
      const headers = parsed[0].map((value) => String(value || "").trim().toLocaleLowerCase());
      const questionColumn = headers.findIndex((value) => ["问题", "question"].includes(value));
      const answerColumn = headers.findIndex((value) => ["标准答案", "ground_truth", "answer"].includes(value));
      if (questionColumn < 0 || answerColumn < 0) throw new Error("首行须包含“问题”和“标准答案”列");
      const importedRows = parsed.slice(1).map((values) => ({
        question: String(values[questionColumn] || "").trim(),
        expected: String(values[answerColumn] || "").trim(),
        result: "", judgment: "待判定",
      })).filter((row) => row.question && row.expected);
      if (!importedRows.length) throw new Error("未找到完整的问题和标准答案数据");
      handleImportedRows(importedRows, file.name);
      importModal.hidden = true;
    }

    function csvCell(value) {
      return `"${String(value ?? "").replaceAll('"', '""')}"`;
    }

    function exportResults() {
      if (!rows.length) {
        showToast("暂无可导出的评测数据");
        return;
      }
      const content = [
        ["问题", "标准答案", "模型结果", "判断结果"],
        ...rows.map((row) => [
          row.question,
          row.expected,
          row.result,
          row.judgment,
        ]),
      ]
        .map((values) => values.map(csvCell).join(","))
        .join("\r\n");
      const blob = new Blob([`\ufeff${content}`], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "prompt-eval-results.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast("评测结果已导出");
    }

    async function startEvaluation() {
      if (evaluating) {
        return;
      }
      if (!selectedPlan()) {
        showToast("请先选择评测方案");
        return;
      }
      if (!rows.length) {
        showToast("请先导入或录入测试数据");
        return;
      }

      evaluating = true;
      startButton.disabled = true;
      saveButton.disabled = true;
      startButton.querySelector("span").textContent = "评测中";
      planSelect.disabled = true;
      evaluationStatus.textContent = "评测中";
      progressLabel.textContent = "正在逐条评测";
      progressHint.textContent = "模型结果和判断结果将持续更新";

      if (!standalonePage) {
        runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        rows.forEach((row) => {
          row.result = "";
          row.judgment = "待判定";
          row.corrected = false;
          row.needsRerun = false;
          delete row.resultId;
          delete row.originalJudgment;
        });
        persistState();
        sendAction({ action: "evaluate_rows", prompt_id: selectedPlan()?.dbId,
          run_id: runId, rows: rows.map((row) => ({ question: row.question, expected: row.expected })) });
        return;
      }

      for (let index = 0; index < rows.length; index += 1) {
        if (signal.aborted) {
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        const isCorrect = index % 5 !== 3 && index % 7 !== 4;
        rows[index].result = isCorrect
          ? `${rows[index].expected}（模拟模型结果）`
          : "模型结果未覆盖标准答案中的关键信息。";
        rows[index].judgment = isCorrect ? "正确" : "错误";
        const completed = index + 1;
        const progress = Math.round((completed / rows.length) * 100);
        progressValue.textContent = `${completed} / ${rows.length}`;
        progressBar.style.width = `${progress}%`;
        progressTrack.setAttribute("aria-valuenow", String(progress));
        if (completed === rows.length || completed % 2 === 0) {
          renderTable();
        }
      }

      evaluating = false;
      startButton.disabled = false;
      saveButton.disabled = false;
      startButton.querySelector("span").textContent = "开始评测";
      planSelect.disabled = false;
      evaluationStatus.textContent = "评测完成";
      progressLabel.textContent = "评测完成";
      progressHint.textContent = "可修改判断结果，指标会实时重算";
      if (!archiveRows(true)) showToast("评测完成，但结果列表保存失败");
      persistState();
      renderTable();
      showToast(`已完成 ${rows.length} 条测试数据评测`);
    }

    populatePlans();
    if (!standalonePage) {
      const evaluation = bridge.args.evaluation_result;
      const prior = readStorageJson(EVAL_STATE_KEY, null);
      if (evaluation && evaluation.run_id === runId && evaluation.token !== prior?.lastEvaluationToken) {
        (evaluation.rows || []).forEach((item) => {
          if (!rows[item.index]) return;
          rows[item.index].result = item.result;
          rows[item.index].judgment = item.judgment;
          rows[item.index].originalJudgment = item.judgment;
          rows[item.index].corrected = false;
          rows[item.index].needsRerun = false;
        });
        writeStorageJson(EVAL_STATE_KEY, { rows, selectedPlanId, runId,
          lastEvaluationToken: evaluation.token, lastSaveToken: prior?.lastSaveToken });
        if (evaluation.status === "error") showToast(evaluation.message);
        else showToast(`已完成 ${rows.length} 条测试数据评测`);
      }
      const saved = bridge.args.evaluation_save_result;
      if (saved && saved.run_id === runId && saved.token !== prior?.lastSaveToken) {
        saved.ids.forEach((id, index) => { if (rows[index]) rows[index].resultId = String(id); });
        writeStorageJson(EVAL_STATE_KEY, { rows, selectedPlanId, runId,
          lastEvaluationToken: evaluation?.token || prior?.lastEvaluationToken,
          lastSaveToken: saved.token });
      }
    }
    renderTable();

    planSelect.addEventListener(
      "change",
      () => {
        selectedPlanId = planSelect.value;
        if (!standalonePage) {
          const saved = (bridge.args.evaluations || []).filter(
            (item) => `db-${item.prompt_id}` === selectedPlanId
          );
          const lastRun = saved[0]?.run_id;
          rows = saved.filter((item) => item.run_id === lastRun).reverse().map((item) => ({
            resultId: String(item.id), question: item.question || "",
            expected: item.s_answer || "", result: item.m_answer || "",
            judgment: item.is_true === 1 ? "正确" : item.is_true === 0 ? "错误" : "待判定",
            corrected: item.is_correct === 1,
            needsRerun: item.needs_rerun === 1,
          }));
          runId = lastRun || `run-${Date.now()}`;
          renderTable();
        }
        updatePlanSummary();
        persistState();
        showToast(`已切换至 ${selectedPlan()?.name || "评测方案"}`);
      },
      { signal }
    );

    showSystemPromptButton.addEventListener("click", () => {
      systemPromptFullText.textContent = selectedPlan()?.systemPrompt || "";
      systemPromptModal.hidden = false;
      systemPromptModal.querySelector("[data-close-modal]").focus();
    }, { signal });

    document.getElementById("editPlanLink").addEventListener("click", () => {
      try { window.sessionStorage.setItem(EDIT_CONTEXT_KEY, JSON.stringify({ type: "plan", planId: selectedPlanId })); }
      catch { /* The destination page can still be opened without prefill. */ }
    }, { signal });

    saveButton.addEventListener(
      "click",
      () => {
        if (!standalonePage) {
          persistState();
          sendAction({ action: "save_evaluation", prompt_id: selectedPlan()?.dbId,
            run_id: runId, rows });
          return;
        }
        if (!archiveRows() || !persistState()) {
          showToast("浏览器未允许保存评测数据");
          return;
        }
        showToast("评测方案、测试数据和纠正结果已保存");
      },
      { signal }
    );

    importButton.addEventListener(
      "click",
      () => {
        fileInput.value = "";
        importError.textContent = "";
        importModal.hidden = false;
        fileInput.focus();
      },
      { signal }
    );

    importForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      importError.textContent = "";
      try { await importFile(fileInput.files?.[0]); }
      catch (error) { importError.textContent = error.message || "导入失败"; }
    }, { signal });

    manualButton.addEventListener("click", () => openEntryModal(), {
      signal,
    });

    startButton.addEventListener("click", () => void startEvaluation(), {
      signal,
    });

    exportButton.addEventListener("click", exportResults, { signal });

    deleteSelectedButton.addEventListener(
      "click",
      () => openDeleteModal([...selectedIndexes]),
      { signal }
    );

    tableBody.addEventListener(
      "change",
      (event) => {
        const checkbox = event.target.closest(".row-check");
        const judgment = event.target.closest(".judgment-switch");
        if (checkbox) {
          const index = Number(checkbox.dataset.index);
          if (checkbox.checked) {
            selectedIndexes.add(index);
          } else {
            selectedIndexes.delete(index);
          }
          renderTable();
          return;
        }

        if (judgment) {
          const index = Number(judgment.dataset.index);
          rows[index].originalJudgment ||= rows[index].judgment;
          rows[index].judgment = judgment.checked ? "正确" : "错误";
          rows[index].corrected = rows[index].judgment !== rows[index].originalJudgment;
          let correctionSaved = true;
          if (rows[index].resultId) {
            const archived = evaluationResults();
            const saved = archived.find((item) => item.id === rows[index].resultId);
            if (saved) {
              saved.judgment = rows[index].judgment;
              saved.corrected = rows[index].corrected;
              correctionSaved = writeStorageJson(EVAL_RESULTS_KEY, archived);
            }
          }
          persistState();
          renderTable();
          showToast(correctionSaved ? `第 ${index + 1} 条已标记为${rows[index].judgment}` : "纠正结果保存失败");
        }
      },
      { signal }
    );

    tableBody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-index]");
      if (button && !evaluating) openDeleteModal([Number(button.dataset.deleteIndex)]);
    }, { signal });

    selectAll.addEventListener(
      "change",
      () => {
        const startIndex = (currentPage - 1) * PAGE_SIZE;
        const pageIndexes = rows
          .slice(startIndex, startIndex + PAGE_SIZE)
          .map((row, index) => startIndex + index);
        pageIndexes.forEach((index) => {
          if (selectAll.checked) {
            selectedIndexes.add(index);
          } else {
            selectedIndexes.delete(index);
          }
        });
        renderTable();
      },
      { signal }
    );

    entryForm.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const question = entryQuestionInput.value.trim();
        const expected = entryAnswerInput.value.trim();
        let valid = true;

        entryQuestionError.textContent = "";
        entryAnswerError.textContent = "";
        if (!question) {
          entryQuestionError.textContent = "请输入测试问题";
          valid = false;
        }
        if (!expected) {
          entryAnswerError.textContent = "请输入标准答案";
          valid = false;
        }
        if (!valid) {
          (question ? entryAnswerInput : entryQuestionInput).focus();
          return;
        }

        if (editingIndex === null) {
          rows.push({
            question,
            expected,
            result: "",
            judgment: "待判定",
          });
          currentPage = Math.ceil(rows.length / PAGE_SIZE);
          showToast("测试数据已添加");
        } else {
          rows[editingIndex] = {
            ...rows[editingIndex],
            question,
            expected,
          };
          showToast("测试数据已更新");
        }
        persistState();
        closeEntryModal();
        renderTable();
      },
      { signal }
    );

    confirmDeleteButton.addEventListener(
      "click",
      () => {
        const deleteSet = new Set(pendingDeleteIndexes);
        rows = rows.filter((row, index) => !deleteSet.has(index));
        selectedIndexes.clear();
        closeDeleteModal();
        persistState();
        renderTable();
        showToast(
          `已删除 ${deleteSet.size} 条测试数据`
        );
      },
      { signal }
    );

    entryQuestionInput.addEventListener(
      "input",
      () => {
        entryQuestionError.textContent = "";
      },
      { signal }
    );

    entryAnswerInput.addEventListener(
      "input",
      () => {
        entryAnswerError.textContent = "";
      },
      { signal }
    );

    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          const modalId = button.dataset.closeModal;
          if (modalId === "entryModal") {
            closeEntryModal();
          } else if (modalId === "deleteModal") {
            closeDeleteModal();
          } else if (modalId === "importModal") {
            importModal.hidden = true;
          } else if (modalId === "systemPromptModal") {
            systemPromptModal.hidden = true;
          }
        },
        { signal }
      );
    });

    [entryModal, deleteModal, importModal, systemPromptModal].forEach((backdrop) => {
      backdrop.addEventListener(
        "click",
        (event) => {
          if (event.target !== backdrop) {
            return;
          }
          if (backdrop === entryModal) {
            closeEntryModal();
          } else if (backdrop === importModal) {
            importModal.hidden = true;
          } else if (backdrop === systemPromptModal) {
            systemPromptModal.hidden = true;
          } else {
            closeDeleteModal();
          }
        },
        { signal }
      );
    });

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") {
          return;
        }
        if (!entryModal.hidden) {
          closeEntryModal();
        } else if (!deleteModal.hidden) {
          closeDeleteModal();
        } else if (!importModal.hidden) {
          importModal.hidden = true;
        } else if (!systemPromptModal.hidden) {
          systemPromptModal.hidden = true;
        }
      },
      { signal }
    );

    bindNavigation();
    if (!standalonePage && savedState?.autoStart) {
      persistState();
      window.setTimeout(() => void startEvaluation(), 0);
    }
  }

  async function render(args) {
    const requestedPage = pages.has(args.page) ? args.page : "server_list";
    const version = ++bridge.renderVersion;
    bridge.args = args;

    try {
      const templateReady = await loadTemplate(requestedPage, version);
      if (!templateReady || version !== bridge.renderVersion) {
        return;
      }

      resetBridgeListeners();

      if (requestedPage === "server_add") {
        renderServerAdd(args);
      } else if (requestedPage === "server_list") {
        renderServerList(args);
      } else if (requestedPage === "model_add") {
        renderModelAdd(args);
      } else if (requestedPage === "prompt_dis") {
        renderPromptDis(args);
      } else if (requestedPage === "prompt_list") {
        renderPromptList(args);
      } else if (requestedPage === "prompt_eval") {
        renderPromptEval(args);
      } else if (requestedPage === "eval_results") {
        renderEvaluationResults(args);
      } else if (requestedPage === "db_schema") {
        window.ImprovePromptDbSchema.init({
          signal: bridge.controller.signal,
          showToast,
          sendAction,
          databaseName: args.schema_database_name,
          schemaData: args.schema_data,
          schemaResult: args.schema_result,
          selected: args.schema_selected,
          search: args.schema_search,
        });
        bindNavigation();
      } else {
        renderModelList(args);
      }

      setFrameHeight();
      if (args.toast) {
        showToast(args.toast);
      }
    } catch (error) {
      console.error(error);
      app.innerHTML = `<pre style="padding:24px;color:#ff9b9b;background:#0f1112;">${escapeHtml(error.message)}</pre>`;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "streamlit:render") {
      return;
    }
    void render(event.data.args || {});
  });

  window.addEventListener("resize", setFrameHeight);
  try {
    window.parent.addEventListener("resize", setFrameHeight);
  } catch {
    // The parent may be unavailable while the component is being mounted.
  }

  postToStreamlit("streamlit:componentReady", {
    apiVersion: 1,
  });
  if (standalonePage) void render({ page: standalonePage });
})();
