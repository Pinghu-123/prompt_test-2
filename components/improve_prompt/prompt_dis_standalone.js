(() => {
  "use strict";

  const PLAN_KEY = "improve_prompt_eval_plans";
  const RESULT_KEY = "improve_prompt_eval_results";
  const STATE_KEY = "improve_prompt_eval_state";
  const CONTEXT_KEY = "improve_prompt_edit_context_v1";
  const { serverData, modelData } = window.promptDisStandaloneData;
  const $ = (id) => document.getElementById(id);
  const read = (key, fallback) => {
    try { return JSON.parse(window.localStorage.getItem(key) || "null") ?? fallback; }
    catch { return fallback; }
  };
  const write = (key, value) => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  };
  let context = null;
  try { context = JSON.parse(window.sessionStorage.getItem(CONTEXT_KEY) || "null"); }
  catch { /* Session storage may be disabled. */ }
  const plans = read(PLAN_KEY, []);
  const results = read(RESULT_KEY, []);
  const editingResult = context?.type === "result"
    ? results.find((item) => item.id === context.resultId) : null;
  const editingPlan = context?.type === "plan" || editingResult
    ? plans.find((plan) => plan.id === (context.planId || editingResult?.planId))
      || plans.find((plan) => plan.name === editingResult?.planName)
      || editingResult?.planSnapshot
      || (editingResult ? plans[0] : null)
    : null;

  if (editingPlan) {
    let server = serverData.find((item) => item.name === editingPlan.server);
    if (!server) {
      server = { id: -1, name: editingPlan.server, company: editingPlan.server, baseUrl: "" };
      serverData.push(server);
      $("serverSelect").add(new Option(`${server.name} · ${server.company}`, String(server.id)));
    }
    let model = modelData.find((item) => item.platform === server.name && item.name === editingPlan.model);
    if (!model) {
      model = { id: -1, platform: server.name, name: editingPlan.model, type: "", inputPrice: 0, outputPrice: 0, unit: "百万" };
      modelData.push(model);
    }
    $("serverSelect").value = String(server.id);
    $("serverSelect").dispatchEvent(new Event("change", { bubbles: true }));
    $("modelSelect").value = String(model.id);
    $("modelSelect").dispatchEvent(new Event("change", { bubbles: true }));
    $("planNameInput").value = editingPlan.name || "";
    $("systemPromptInput").value = editingPlan.systemPrompt || "";
    $("userPromptInput").value = editingPlan.userPrompt || "";
    $("systemPromptInput").dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (editingResult) {
    $("resultEditFields").hidden = false;
    $("resultQuestionInput").value = editingResult.question || "";
    $("resultExpectedInput").value = editingResult.expected || "";
    if (!editingPlan) $("planNameInput").value = editingResult.planName || "";
  }

  $("saveEvalPlanButton").addEventListener("click", () => {
    const server = serverData.find((item) => String(item.id) === $("serverSelect").value);
    const model = modelData.find((item) => String(item.id) === $("modelSelect").value);
    const systemPrompt = $("systemPromptInput").value.trim();
    const userPrompt = $("userPromptInput").value.trim();
    const question = $("resultQuestionInput").value.trim();
    const expected = $("resultExpectedInput").value.trim();
    if (!server || !model || !systemPrompt || !userPrompt) {
      $("pageStatusText").textContent = "请填写服务器、模型和提示词";
      return;
    }
    if (editingResult && (!question || !expected)) {
      $("pageStatusText").textContent = "请填写问题和标准答案";
      return;
    }
    const currentPlans = read(PLAN_KEY, []);
    const planName = $("planNameInput").value.trim() || `${model.name} · ${userPrompt.slice(0, 14)}`;
    const duplicate = currentPlans.find((item) => item.server === server.name && item.model === model.name
      && item.systemPrompt === systemPrompt && item.userPrompt === userPrompt);
    const plan = { id: editingPlan?.id || duplicate?.id || `plan-${Date.now()}`,
      name: planName, server: server.name, model: model.name, systemPrompt, userPrompt };
    const nextPlans = [plan, ...currentPlans.filter((item) => item.id !== plan.id)];
    if (!write(PLAN_KEY, nextPlans)) { $("pageStatusText").textContent = "方案保存失败"; return; }

    const changed = editingPlan && ["name", "server", "model", "systemPrompt", "userPrompt"]
      .some((field) => editingPlan[field] !== plan[field]);
    const rowChanged = editingResult && (question !== editingResult.question || expected !== editingResult.expected);
    if (changed || editingResult) {
      const updated = read(RESULT_KEY, []).map((item) => {
        const isEditedRow = editingResult && item.id === editingResult.id;
        const belongsToPlan = editingPlan && (item.planId === editingPlan.id || item.planName === editingPlan.name);
        if (!isEditedRow && !belongsToPlan) return item;
        return { ...item, planId: plan.id, planName: plan.name, planSnapshot: { ...plan },
          question: isEditedRow ? question : item.question,
          expected: isEditedRow ? expected : item.expected,
          needsRerun: item.needsRerun || Boolean(changed) || Boolean(isEditedRow && rowChanged) };
      });
      if (!write(RESULT_KEY, updated)) { $("pageStatusText").textContent = "评测数据保存失败"; return; }
      if (editingResult) {
        const state = read(STATE_KEY, null);
        const row = state?.rows?.find((item) => item.resultId === editingResult.id);
        if (row) { row.question = question; row.expected = expected; write(STATE_KEY, state); }
      }
    }
    try { window.sessionStorage.removeItem(CONTEXT_KEY); } catch { /* Session storage may be disabled. */ }
    window.location.href = "prompt_list.html";
  });
})();
