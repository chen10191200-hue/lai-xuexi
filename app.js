const KEY = "apple-study-v1";
const today = () => new Date().toLocaleDateString("sv-SE");
const addDays = (date, days) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + days); return d.toLocaleDateString("sv-SE"); };
const daysBetween = (a, b) => Math.max(0, Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000));
const uid = () => crypto.randomUUID();

let state;
try { state = window.__nativeState || JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { state = {}; }
state.goals ||= []; state.tasks ||= []; state.sessions ||= [];
state.tasks.forEach((task, index) => { if (!Number.isFinite(task.order)) task.order = index; });

let taskFilter = "all";
let editingTaskId = null;
let editingGoalId = null;
let creatingEvent = false;
let draggingTaskId = null;
let calendarOffset = 0;
let timetableDays = 7;
let currentView = "today";
let timerDurationMinutes = state.timer?.durationMinutes || 25;
let timerSeconds = state.timer?.running ? Math.max(0, Math.ceil((state.timer.endAt - Date.now()) / 1000)) : (state.timer?.remainingSeconds || timerDurationMinutes * 60);
let timerEndAt = state.timer?.endAt || null;
let timerHandle = null;
let pendingCompletionId = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const save = () => {
  localStorage.setItem(KEY, JSON.stringify(state));
  window.webkit?.messageHandlers?.nativeStore?.postMessage(state);
  syncNativeReminders();
};
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
const goalName = (id) => state.goals.find(goal => goal.id === id)?.title || "普通待办";
const formatDate = (date) => new Intl.DateTimeFormat("zh-CN", {month:"short", day:"numeric"}).format(new Date(`${date}T12:00:00`));
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const nextOrder = () => Math.max(-1, ...state.tasks.map(task => task.order ?? 0)) + 1;
const TIMETABLE_START = 8 * 60, TIMETABLE_END = 22 * 60;
const formatTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2,"0")}:${String(minutes % 60).padStart(2,"0")}`;
const rangesOverlap = (aStart, aMinutes, bStart, bMinutes) => aStart < bStart + bMinutes && aStart + aMinutes > bStart;
const priorityRank = {highest:0, high:1, medium:2, low:3, lowest:4};
const priorityLabel = {highest:"最高", high:"高", medium:"中", low:"低", lowest:"最低"};
const taskPriority = task => task.priority || state.goals.find(goal => goal.id === task.goalId)?.priority || "medium";
const parseTime = value => value ? Number(value.slice(0,2)) * 60 + Number(value.slice(3,5)) : null;
const syncNativeReminders = () => {
  const grouped = new Map();
  state.tasks.filter(task => !task.done && task.date >= today()).forEach(task => {
    if (!grouped.has(task.date)) grouped.set(task.date, []);
    grouped.get(task.date).push(task);
  });
  const reminders = [...grouped].sort().slice(0, 30).map(([date, tasks]) => ({
    identifier:`study-${date}`, at:new Date(`${date}T09:00:00`).getTime(),
    title:tasks.some(task => task.isReview) ? "今天有知识需要复习" : `今天有 ${tasks.length} 项学习任务`,
    body:tasks.slice(0, 2).map(task => task.title).join("、")
  })).filter(reminder => reminder.at > Date.now() + 60000);
  window.webkit?.messageHandlers?.nativeReminders?.postMessage(reminders);
};

function showToast(message, actionLabel = "", action = null) {
  const toast = $("#toast");
  toast.replaceChildren(document.createTextNode(message));
  if (actionLabel && action) {
    const button = document.createElement("button");
    button.textContent = actionLabel;
    button.addEventListener("click", () => { clearTimeout(showToast.handle); toast.classList.remove("show"); action(); });
    toast.append(button);
  }
  toast.classList.add("show");
  clearTimeout(showToast.handle);
  showToast.handle = setTimeout(() => toast.classList.remove("show"), action ? 5000 : 2200);
}

function removeTaskWithUndo(id) {
  const index = state.tasks.findIndex(task => task.id === id);
  if (index < 0) return;
  const [removed] = state.tasks.splice(index, 1);
  save(); render();
  showToast("任务已删除。", "撤销", () => { state.tasks.splice(index, 0, removed); save(); render(); showToast("已恢复任务。"); });
}

function taskTemplate(task, showDate = false, draggable = false) {
  const overdue = !task.done && task.date < today();
  return `<article class="task ${task.done ? "done" : ""}" data-id="${task.id}" ${draggable ? 'draggable="true"' : ""}>
    <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} aria-label="完成 ${escapeHtml(task.title)}">
    <div><div class="task-title">${escapeHtml(task.title)}</div><div class="task-meta">
      <span>${Number.isFinite(task.startMinutes) ? `${formatTime(task.startMinutes)} · ` : ""}${task.minutes} 分钟</span>${showDate ? `<span class="${overdue ? "tag overdue" : ""}">${overdue ? "已逾期 · " : ""}${formatDate(task.date)}</span>` : ""}
      ${task.isReview ? '<span class="tag review-tag">间隔复习</span>' : ''}${task.isEvent ? `<span class="tag event-tag">计划事件</span><span class="tag priority-tag priority-${taskPriority(task)}">${priorityLabel[taskPriority(task)]}</span>` : ""}<span class="tag">${escapeHtml(goalName(task.goalId))}</span>
    </div></div><div class="task-actions"><button class="task-action" data-edit aria-label="编辑任务">✎</button><button class="task-action" data-delete aria-label="删除任务">×</button></div>
  </article>`;
}

function handleCompletion(task, checkbox) {
  if (checkbox.checked && !task.isEvent) { checkbox.checked = false; askMastery(task); return; }
  task.done = checkbox.checked; task.doneAt = task.done ? new Date().toISOString() : null; task.mastery = null;
  save(); render(); if (task.done) showToast("事件已完成。");
}

const reviewDelay = mastery => ({mastered:7, fuzzy:3, relearn:1})[mastery] || 1;

function askMastery(task) {
  pendingCompletionId = task.id;
  $("#masteryTaskTitle").textContent = task.title;
  $("#masteryDialog").showModal();
}

function completeTask(mastery) {
  const task = state.tasks.find(item => item.id === pendingCompletionId);
  if (!task) return;
  task.done = true;
  task.doneAt = new Date().toISOString();
  task.mastery = mastery;
  const delay = reviewDelay(mastery);
  state.tasks.push({id:uid(), goalId:task.goalId, title:`复习 · ${task.title.replace(/^复习 · /, "")}`, minutes:Math.min(task.minutes, 30), date:addDays(today(), delay), done:false, doneAt:null, order:nextOrder(), isReview:true, sourceTaskId:task.sourceTaskId || task.id});
  pendingCompletionId = null;
  save(); render();
  $("#masteryDialog").close();
  showToast(`已完成，${delay === 1 ? "明天" : `${delay} 天后`}复习。`);
}

function reorderTasks(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const ordered = [...state.tasks].sort(byOrder);
  const from = ordered.findIndex(task => task.id === fromId);
  const to = ordered.findIndex(task => task.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  ordered.forEach((task, index) => task.order = index);
  save(); render(); showToast("任务顺序已更新。");
}

function bindTasks(container, allowReorder = false) {
  container.querySelectorAll(".task").forEach(row => {
    const id = row.dataset.id;
    row.querySelector(".task-check").addEventListener("change", event => {
      const task = state.tasks.find(item => item.id === id);
      handleCompletion(task, event.target);
    });
    row.querySelector("[data-edit]").addEventListener("click", () => openTaskDialog(id));
    row.querySelector("[data-delete]").addEventListener("click", () => removeTaskWithUndo(id));
    if (!allowReorder) return;
    row.addEventListener("dragstart", () => { draggingTaskId = id; row.classList.add("dragging"); });
    row.addEventListener("dragend", () => { draggingTaskId = null; row.classList.remove("dragging"); $$(".drag-over").forEach(item => item.classList.remove("drag-over")); });
    row.addEventListener("dragover", event => { event.preventDefault(); if (draggingTaskId !== id) row.classList.add("drag-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", event => { event.preventDefault(); row.classList.remove("drag-over"); reorderTasks(draggingTaskId, id); });
  });
}

function renderToday() {
  const relevant = state.tasks.filter(task => !task.done && task.date <= today()).sort(byOrder);
  const dueToday = state.tasks.filter(task => task.date === today());
  const doneToday = dueToday.filter(task => task.done).length;
  const progress = dueToday.length ? Math.round(doneToday / dueToday.length * 100) : 0;
  const minutes = relevant.reduce((sum, task) => sum + task.minutes, 0);
  const reviews = relevant.filter(task => task.isReview).length;
  $("#heroHeadline").textContent = relevant.length ? `${relevant.length} 件事，从最小的一步开始` : (state.goals.length ? "今天的计划已经完成" : "先创建一个学习目标");
  $("#heroSubline").textContent = relevant.length ? `大约 ${minutes} 分钟。不用想完全部，只先开始第一项。` : (state.goals.length ? "留一点空白，明天再继续。" : "我会帮你把目标拆成可执行的每日任务。");
  $("#progressPercent").textContent = `${progress}%`;
  $("#progressRing").style.setProperty("--progress", `${progress}%`);
  $("#todayMinutes").textContent = `${minutes} 分钟`;
  $("#todayCount").textContent = `${relevant.length} 项`;
  $("#reviewCount").textContent = `${reviews} 项`;
  $("#todayTasks").innerHTML = relevant.length ? relevant.map(task => taskTemplate(task, false, true)).join("") : `<div class="empty"><strong>${state.goals.length ? "今天没有待完成任务" : "还没有学习计划"}</strong>${state.goals.length ? "去做点其他事吧。" : "从一个清晰的目标开始。"}</div>`;
  bindTasks($("#todayTasks"), true);
  renderReviewHub();
}

function renderReviewHub() {
  const reviews = state.tasks.filter(task => task.isReview && !task.done).sort((a,b) => a.date.localeCompare(b.date) || byOrder(a,b));
  const due = reviews.filter(task => task.date <= today()), next = reviews[0], button = $("#reviewStart");
  $("#reviewHub").classList.toggle("ready", Boolean(due.length));
  $("#reviewTitle").textContent = due.length ? `${due.length} 项知识等待巩固` : (next ? `下一次复习在 ${formatDate(next.date)}` : "复习会在这里出现");
  $("#reviewMeta").textContent = due.length ? due[0].title : (next ? next.title : "完成任务后，我会按掌握度安排下一次复习。");
  button.disabled = !next; button.textContent = due.length ? "开始复习" : (next ? "查看安排" : "暂无复习");
}

function openReviewHub() {
  const review = state.tasks.filter(task => task.isReview && !task.done).sort((a,b) => a.date.localeCompare(b.date))[0];
  if (!review) return;
  if (review.date > today()) { showView("todo"); $(".filter[data-filter='open']").click(); return; }
  showView("today"); requestAnimationFrame(() => {
    const row = $(`.task[data-id="${review.id}"]`); row?.scrollIntoView({behavior:"smooth", block:"center"}); row?.classList.add("spotlight"); setTimeout(() => row?.classList.remove("spotlight"), 1800);
  });
}

function weekStart(offset = 0) {
  const base = new Date(`${today()}T12:00:00`);
  base.setDate(base.getDate() - ((base.getDay() + 6) % 7) + offset * 7);
  return base.toLocaleDateString("sv-SE");
}

function renderCalendar() {
  const start = weekStart(calendarOffset);
  const dates = Array.from({length:7}, (_, index) => addDays(start, index));
  $("#calendarRange").textContent = `${formatDate(dates[0])} — ${formatDate(dates[6])}`;
  $("#weekCalendar").innerHTML = dates.map((date, index) => {
    const tasks = state.tasks.filter(task => task.date === date).sort(byOrder);
    return `<div class="calendar-day ${date === today() ? "today" : ""}" data-date="${date}"><div class="calendar-date"><span>${["一","二","三","四","五","六","日"][index]}</span><strong>${Number(date.slice(8))}</strong></div><div class="calendar-tasks">${tasks.length ? tasks.map(task => `<button class="calendar-task priority-${taskPriority(task)} ${task.done ? "done" : ""}" draggable="true" data-id="${task.id}" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</button>`).join("") : `<div class="calendar-empty">空</div>`}</div></div>`;
  }).join("");
  $$(".calendar-task").forEach(chip => {
    chip.addEventListener("click", () => openTaskDialog(chip.dataset.id));
    chip.addEventListener("dragstart", () => { draggingTaskId = chip.dataset.id; });
    chip.addEventListener("dragend", () => { draggingTaskId = null; $$(".drop-target").forEach(day => day.classList.remove("drop-target")); });
  });
  $$(".calendar-day").forEach(day => {
    day.addEventListener("dragover", event => { event.preventDefault(); day.classList.add("drop-target"); });
    day.addEventListener("dragleave", () => day.classList.remove("drop-target"));
    day.addEventListener("drop", event => {
      event.preventDefault(); day.classList.remove("drop-target");
      const task = state.tasks.find(item => item.id === draggingTaskId);
      if (!task || task.date === day.dataset.date) return;
      task.date = day.dataset.date; task.startMinutes = null;
      save(); render(); showToast(`已移动到 ${formatDate(task.date)}。`);
    });
  });
  renderTimetable(Array.from({length:timetableDays}, (_, index) => addDays(today(), index)));
}

function hasTimeConflict(taskId, date, startMinutes, minutes = null) {
  const duration = minutes ?? state.tasks.find(item => item.id === taskId)?.minutes; if (!duration) return false;
  return state.tasks.some(item => item.id !== taskId && item.date === date && Number.isFinite(item.startMinutes) && rangesOverlap(startMinutes, duration, item.startMinutes, item.minutes));
}

function findOpenTime(task, date) {
  for (let start = TIMETABLE_START; start + task.minutes <= TIMETABLE_END; start += 15) if (!hasTimeConflict(task.id, date, start)) return start;
  return null;
}

function renderTimetable(dates) {
  const weekTasks = state.tasks.filter(task => dates.includes(task.date));
  const unplanned = weekTasks.filter(task => !task.done && !Number.isFinite(task.startMinutes)).sort((a,b) => a.date.localeCompare(b.date) || byOrder(a,b));
  $("#timetableUnplanned").classList.toggle("hidden", !unplanned.length);
  $("#timetableUnplanned").innerHTML = unplanned.length ? `<strong>${unplanned.length} 项待安排</strong>${unplanned.map(task => `<span>${escapeHtml(task.title)}</span>`).join("")}` : "";
  $("#autoTimetable").textContent = unplanned.length ? `自动排入 ${unplanned.length} 项` : "已全部安排";
  $("#autoTimetable").disabled = !unplanned.length;
  const hours = Array.from({length:(TIMETABLE_END - TIMETABLE_START) / 60 + 1}, (_, index) => TIMETABLE_START + index * 60);
  $("#timetableRangeTitle").textContent = `未来 ${dates.length} 天`;
  $("#timetable").style.cssText = `min-width:${54 + dates.length * 118}px;grid-template-columns:54px repeat(${dates.length},minmax(118px,1fr))`;
  $("#timetable").innerHTML = `<div class="timetable-corner"></div>${dates.map(date => `<div class="timetable-day-head ${date === today() ? "today" : ""}"><span>周${["日","一","二","三","四","五","六"][new Date(`${date}T12:00:00`).getDay()]}</span><strong>${Number(date.slice(8))}</strong></div>`).join("")}
    <div class="timetable-times">${hours.map(time => `<span style="top:${(time - TIMETABLE_START) / 60 * 52}px">${formatTime(time)}</span>`).join("")}</div>
    ${dates.map(date => {
      const tasks = weekTasks.filter(task => task.date === date && Number.isFinite(task.startMinutes));
      const now = new Date(), nowMinutes = now.getHours() * 60 + now.getMinutes();
      return `<div class="timetable-track ${date === today() ? "today" : ""}" data-date="${date}">${date === today() && nowMinutes >= TIMETABLE_START && nowMinutes <= TIMETABLE_END ? `<span class="now-line" style="top:${(nowMinutes - TIMETABLE_START) / 60 * 52}px"></span>` : ""}${tasks.map(task => {
        const conflict = hasTimeConflict(task.id, date, task.startMinutes);
        return `<article class="timetable-task priority-${taskPriority(task)} ${task.done ? "done" : ""} ${task.isReview ? "review" : ""} ${task.isEvent ? "event" : ""} ${conflict ? "conflict" : ""}" draggable="true" data-id="${task.id}" data-title="${escapeHtml(task.title)}" title="${escapeHtml(task.title)}" style="top:${(task.startMinutes - TIMETABLE_START) / 60 * 52}px;height:${Math.max(32, task.minutes / 60 * 52 - 3)}px"><input type="checkbox" ${task.done ? "checked" : ""} aria-label="完成 ${escapeHtml(task.title)}"><strong>${escapeHtml(task.title)}</strong><span>${priorityLabel[taskPriority(task)]} · ${formatTime(task.startMinutes)} · ${task.minutes} 分钟</span></article>`;
      }).join("")}</div>`;
    }).join("")}`;
  $$(".timetable-task").forEach(block => {
    block.addEventListener("click", event => { if (event.target.tagName !== "INPUT") openTaskDialog(block.dataset.id); });
    block.addEventListener("dragstart", event => { draggingTaskId = block.dataset.id; event.dataTransfer.setData("text/plain", draggingTaskId); block.classList.add("dragging"); });
    block.addEventListener("dragend", () => { draggingTaskId = null; block.classList.remove("dragging"); $$(".timetable-track").forEach(track => track.classList.remove("drop-target")); });
    block.querySelector("input").addEventListener("change", event => {
      const task = state.tasks.find(item => item.id === block.dataset.id);
      handleCompletion(task, event.target);
    });
  });
  $$(".timetable-track").forEach(track => {
    track.addEventListener("dragover", event => { event.preventDefault(); track.classList.add("drop-target"); });
    track.addEventListener("dragleave", () => track.classList.remove("drop-target"));
    track.addEventListener("drop", event => {
      event.preventDefault(); track.classList.remove("drop-target");
      const task = state.tasks.find(item => item.id === draggingTaskId); if (!task) return;
      const rect = track.getBoundingClientRect();
      const start = Math.max(TIMETABLE_START, Math.min(TIMETABLE_END - task.minutes, TIMETABLE_START + Math.round((event.clientY - rect.top) / 52 * 4) * 15));
      if (hasTimeConflict(task.id, track.dataset.date, start)) return showToast("这个时间已经有安排，请换一个位置。");
      task.date = track.dataset.date; task.startMinutes = start; save(); render(); showToast(`已安排在 ${formatDate(task.date)} ${formatTime(start)}。`);
    });
  });
}

function autoArrangeTimetable() {
  const dates = Array.from({length:timetableDays}, (_, index) => addDays(today(), index));
  const tasks = state.tasks.filter(task => dates.includes(task.date) && !task.done && !Number.isFinite(task.startMinutes)).sort((a,b) => a.date.localeCompare(b.date) || priorityRank[taskPriority(a)] - priorityRank[taskPriority(b)] || byOrder(a,b));
  let arranged = 0;
  tasks.forEach(task => { const slot = findOpenTime(task, task.date); if (slot !== null) { task.startMinutes = slot; arranged++; } });
  save(); render(); showToast(arranged === tasks.length ? `已安排 ${arranged} 项任务。` : `已安排 ${arranged} 项，其余需要调整日期。`);
}

function renderGoals() {
  const overdue = state.tasks.filter(task => !task.done && task.date < today());
  $("#recoveryBanner").classList.toggle("hidden", !overdue.length);
  $("#recoveryText").textContent = `${overdue.length} 个任务已过期。我会按每日容量和截止日期重新安排。`;
  $("#goalList").innerHTML = state.goals.length ? state.goals.map(goal => {
    const tasks = state.tasks.filter(task => task.goalId === goal.id);
    const done = tasks.filter(task => task.done).length;
    const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const left = Math.max(0, daysBetween(today(), goal.deadline));
    return `<article class="goal-card" data-goal="${goal.id}"><div class="goal-top"><div class="goal-icon">${goal.priority === "high" ? "!" : "↗"}</div><div class="goal-actions"><button class="text-button" data-edit-goal>编辑</button><button class="danger-link" data-delete-goal>删除</button></div></div><h3>${escapeHtml(goal.title)}</h3><p class="muted">${left} 天后截止 · 每天 ${goal.dailyMinutes} 分钟</p><div class="goal-progress"><span style="width:${percent}%"></span></div><div class="goal-stats"><span>${done} / ${tasks.length} 任务</span><strong>${percent}%</strong></div></article>`;
  }).join("") : `<div class="panel empty"><strong>还没有目标</strong>创建一个目标，自动生成每日计划。</div>`;
  $$('[data-edit-goal]').forEach(button => button.addEventListener("click", () => openGoalDialog(button.closest("[data-goal]").dataset.goal)));
  $$('[data-delete-goal]').forEach(button => button.addEventListener("click", () => {
    const id = button.closest("[data-goal]").dataset.goal;
    const goalIndex = state.goals.findIndex(goal => goal.id === id);
    const taskSnapshots = state.tasks.filter(task => task.goalId === id);
    const [goal] = state.goals.splice(goalIndex, 1);
    state.tasks = state.tasks.filter(task => task.goalId !== id);
    save(); render();
    showToast("目标及其任务已删除。", "撤销", () => {
      state.goals.splice(goalIndex, 0, goal); state.tasks.push(...taskSnapshots);
      save(); render(); showToast("已恢复目标。");
    });
  }));
}

function renderAllTasks() {
  const tasks = state.tasks.filter(task => taskFilter === "all" || (taskFilter === "done" ? task.done : !task.done)).sort((a,b) => a.date.localeCompare(b.date) || byOrder(a,b));
  $("#allTasks").innerHTML = tasks.length ? tasks.map(task => taskTemplate(task, true)).join("") : `<div class="empty"><strong>这里是空的</strong>没有符合当前筛选的任务。</div>`;
  bindTasks($("#allTasks"));
}

function renderData() {
  const last7 = Array.from({length:7}, (_, index) => addDays(today(), index - 6));
  const sessions = state.sessions.filter(session => last7.includes(session.date));
  const totalMinutes = sessions.reduce((sum, session) => sum + session.minutes, 0);
  const weekTasks = state.tasks.filter(task => last7.includes(task.date));
  const weekDone = weekTasks.filter(task => task.done).length;
  $("#weekMinutes").textContent = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  $("#completionRate").textContent = `${weekTasks.length ? Math.round(weekDone / weekTasks.length * 100) : 0}%`;
  $("#completionMeta").textContent = `${weekDone} / ${weekTasks.length} 任务`;
  const activeDates = new Set(state.sessions.map(session => session.date));
  let streak = 0; for (let index = 0; activeDates.has(addDays(today(), -index)); index++) streak++;
  $("#streakDays").textContent = `${streak} 天`;
  const perDay = last7.map(date => sessions.filter(session => session.date === date).reduce((sum, session) => sum + session.minutes, 0));
  const max = Math.max(60, ...perDay);
  $("#weekChart").innerHTML = last7.map((date,index) => `<div class="bar-wrap"><div class="bar ${date === today() ? "today" : ""}" style="height:${Math.max(4, perDay[index] / max * 85)}%" title="${perDay[index]} 分钟"></div><span>${["日","一","二","三","四","五","六"][new Date(`${date}T12:00:00`).getDay()]}</span></div>`).join("");
  $("#goalHealth").innerHTML = state.goals.length ? state.goals.map(goal => {
    const tasks = state.tasks.filter(task => task.goalId === goal.id); const done = tasks.filter(task => task.done).length; const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    return `<div class="health-item"><p><span>${escapeHtml(goal.title)}</span><strong>${percent}%</strong></p><div class="health-bar"><span style="width:${percent}%"></span></div></div>`;
  }).join("") : `<div class="empty"><strong>暂无数据</strong>创建目标后，进度会显示在这里。</div>`;
}

function render() { renderToday(); renderCalendar(); renderGoals(); renderAllTasks(); renderData(); populateGoalSelect(); }

function populateGoalSelect() {
  $("#taskGoalSelect").innerHTML = `<option value="">普通待办</option>` + state.goals.map(goal => `<option value="${goal.id}">${escapeHtml(goal.title)}</option>`).join("");
}

function generateGoal(form) {
  const data = Object.fromEntries(new FormData(form));
  const goal = {id:uid(), title:data.title.trim(), deadline:data.deadline, dailyMinutes:Number(data.dailyMinutes), chapters:Number(data.chapters), level:data.level, priority:data.priority, createdAt:today()};
  const availableDays = Math.max(1, daysBetween(today(), goal.deadline));
  const taskMinutes = Math.min(90, Math.max(20, Math.round(goal.dailyMinutes / 15) * 15));
  state.goals.push(goal);
  for (let index = 0; index < goal.chapters; index++) {
    const offset = Math.floor(index * availableDays / Math.max(1, goal.chapters - 1));
    state.tasks.push({id:uid(), goalId:goal.id, title:`${goal.title} · 第 ${index + 1} 章`, minutes:taskMinutes, date:addDays(today(), offset), priority:goal.priority, done:false, doneAt:null, order:nextOrder()});
  }
  save(); render(); showView("plan"); showToast("学习计划已生成。");
}

function openGoalDialog(id = null) {
  editingGoalId = id;
  const form = $("#goalForm"), goal = state.goals.find(item => item.id === id);
  form.reset(); form.elements.chapters.disabled = Boolean(goal);
  $("#goalDialogEyebrow").textContent = goal ? "编辑学习目标" : "新建学习目标";
  $("#goalDialogTitle").textContent = goal ? "调整接下来的节奏" : "你想完成什么？";
  $("#saveGoal").textContent = goal ? "保存并重排" : "生成学习计划";
  form.elements.deadline.min = today();
  form.elements.title.value = goal?.title || "";
  form.elements.deadline.value = goal?.deadline || addDays(today(), 30);
  form.elements.dailyMinutes.value = goal?.dailyMinutes || 60;
  form.elements.level.value = goal?.level || "有一些基础";
  form.elements.chapters.value = goal?.chapters || 12;
  form.elements.priority.value = goal?.priority || "medium";
  $("#goalDialog").showModal();
}

function updateGoal(form) {
  const goal = state.goals.find(item => item.id === editingGoalId); if (!goal) return;
  const data = Object.fromEntries(new FormData(form)), oldTitle = goal.title;
  Object.assign(goal, {title:data.title.trim(), deadline:data.deadline, dailyMinutes:Number(data.dailyMinutes), level:data.level, priority:data.priority});
  const usage = new Map();
  state.tasks.filter(task => task.goalId === goal.id && !task.done).sort((a,b) => a.date.localeCompare(b.date) || byOrder(a,b)).forEach(task => {
    if (task.title.startsWith(`${oldTitle} · 第`)) task.title = task.title.replace(oldTitle, goal.title);
    task.date = chooseScheduleDate(task, goal, usage); task.startMinutes = null;
    const key = `${goal.id}|${task.date}`; usage.set(key, (usage.get(key) || 0) + task.minutes);
  });
  save(); render(); showToast("目标已更新，未完成任务已重排。");
}

function chooseScheduleDate(task, goal, usage) {
  const capacity = goal?.dailyMinutes || 60;
  const deadline = goal?.deadline >= today() ? goal.deadline : addDays(today(), 7);
  const span = Math.min(365, daysBetween(today(), deadline));
  let leastBusy = today(), leastMinutes = Infinity;
  for (let offset = 0; offset <= span; offset++) {
    const date = addDays(today(), offset);
    const key = `${task.goalId || "general"}|${date}`;
    const used = usage.get(key) || 0;
    if (used < leastMinutes) { leastMinutes = used; leastBusy = date; }
    if (used + task.minutes <= capacity) return date;
  }
  return leastBusy;
}

function recoverPlans() {
  const priority = {high:0, medium:1, low:2};
  const overdue = state.tasks.filter(task => !task.done && task.date < today()).sort((a,b) => (priority[state.goals.find(goal => goal.id === a.goalId)?.priority] ?? 1) - (priority[state.goals.find(goal => goal.id === b.goalId)?.priority] ?? 1) || a.date.localeCompare(b.date));
  const usage = new Map();
  state.tasks.filter(task => !task.done && task.date >= today()).forEach(task => {
    const key = `${task.goalId || "general"}|${task.date}`;
    usage.set(key, (usage.get(key) || 0) + task.minutes);
  });
  overdue.forEach(task => {
    const goal = state.goals.find(item => item.id === task.goalId);
    task.date = chooseScheduleDate(task, goal, usage); task.startMinutes = null;
    const key = `${task.goalId || "general"}|${task.date}`;
    usage.set(key, (usage.get(key) || 0) + task.minutes);
  });
  save(); render(); showToast(`已按容量重新安排 ${overdue.length} 个任务。`);
}

function showView(name) {
  const order = ["today","plan","todo","data"];
  if (name !== currentView) {
    $("main").dataset.direction = order.indexOf(name) > order.indexOf(currentView) ? "forward" : "back";
    const nav = $("nav"); nav.dataset.direction = order.indexOf(name) > order.indexOf(currentView) ? "down" : "up"; nav.classList.remove("moving"); void nav.offsetWidth; nav.classList.add("moving");
    clearTimeout(showView.motion); showView.motion = setTimeout(() => nav.classList.remove("moving"), 620);
    currentView = name;
  }
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `${name}View`));
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === name));
  $("#pageTitle").textContent = {today:"今日",plan:"计划",todo:"待办",data:"数据"}[name];
  window.scrollTo({top:0, behavior:"smooth"});
}

function openTaskDialog(id = null, asEvent = false) {
  editingTaskId = id;
  creatingEvent = asEvent;
  const form = $("#taskForm");
  form.reset(); populateGoalSelect();
  const task = state.tasks.find(item => item.id === id);
  const eventMode = task?.isEvent || asEvent;
  $("#taskDialogEyebrow").textContent = eventMode ? (task ? "编辑计划事件" : "新建计划事件") : (task ? "编辑待办" : "新建待办");
  $("#taskDialogTitle").textContent = eventMode ? "安排一段明确的时间" : (task ? "调整任务内容" : "添加一个清晰的任务");
  $("#taskNameLabel").textContent = eventMode ? "事件名称" : "任务名称";
  form.elements.title.placeholder = eventMode ? "例：物理重点复习" : "例：阅读第 3 章";
  $("#saveTask").textContent = task ? "保存修改" : (eventMode ? "添加事件" : "添加任务");
  form.elements.title.value = task?.title || "";
  form.elements.date.value = task?.date || today();
  form.elements.minutes.value = task?.minutes || 30;
  form.elements.startTime.value = Number.isFinite(task?.startMinutes) ? formatTime(task.startMinutes) : (eventMode ? "09:00" : "");
  form.elements.priority.value = task ? taskPriority(task) : "medium";
  form.elements.goalId.value = task?.goalId || "";
  $("#taskDialog").showModal();
}

function setTimer(minutes) {
  if (timerHandle) return showToast("请先暂停当前专注。");
  timerDurationMinutes = Math.max(5, Math.min(180, Number(minutes) || 25));
  timerSeconds = timerDurationMinutes * 60;
  timerEndAt = null;
  state.timer = {durationMinutes:timerDurationMinutes, remainingSeconds:timerSeconds, endAt:null, running:false};
  save();
  $$(".timer-preset").forEach(button => button.classList.toggle("active", Number(button.dataset.minutes) === timerDurationMinutes));
  $("#timerHint").textContent = `${timerDurationMinutes} 分钟，只做一件事`;
  updateTimer();
}

function updateTimer() {
  const minutes = String(Math.floor(timerSeconds / 60)).padStart(2,"0"), seconds = String(timerSeconds % 60).padStart(2,"0");
  $("#timer").textContent = `${minutes}:${seconds}`;
  document.title = timerHandle ? `${minutes}:${seconds} · Apple 来学习` : "Apple · 来学习";
}

function resetTimer() {
  clearInterval(timerHandle); timerHandle = null; timerEndAt = null; timerSeconds = timerDurationMinutes * 60;
  state.timer = {durationMinutes:timerDurationMinutes, remainingSeconds:timerSeconds, endAt:null, running:false};
  save(); updateTimer();
  $("#timerToggle").textContent = "开始专注";
  $(".focus-panel").classList.remove("running");
}

function finishTimer() {
  clearInterval(timerHandle); timerHandle = null; timerEndAt = null;
  state.sessions.push({id:uid(), minutes:timerDurationMinutes, date:today()});
  timerSeconds = timerDurationMinutes * 60;
  state.timer = {durationMinutes:timerDurationMinutes, remainingSeconds:timerSeconds, endAt:null, running:false};
  save(); renderData(); updateTimer();
  $("#timerToggle").textContent = "开始专注"; $(".focus-panel").classList.remove("running");
  showToast(`完成一次 ${timerDurationMinutes} 分钟专注。`);
  window.webkit?.messageHandlers?.nativeNotify?.postMessage({title:"专注完成", body:`你完成了 ${timerDurationMinutes} 分钟学习。`});
}

function tickTimer() {
  timerSeconds = Math.max(0, Math.ceil((timerEndAt - Date.now()) / 1000));
  updateTimer();
  if (timerSeconds <= 0) finishTimer();
}

function startTimer(restoring = false) {
  if (!restoring) timerEndAt = Date.now() + timerSeconds * 1000;
  state.timer = {durationMinutes:timerDurationMinutes, remainingSeconds:timerSeconds, endAt:timerEndAt, running:true};
  save();
  $("#timerToggle").textContent = "暂停"; $(".focus-panel").classList.add("running");
  timerHandle = setInterval(tickTimer, 1000); tickTimer();
}

function pauseTimer() {
  tickTimer(); if (!timerHandle) return;
  clearInterval(timerHandle); timerHandle = null; timerEndAt = null;
  state.timer = {durationMinutes:timerDurationMinutes, remainingSeconds:timerSeconds, endAt:null, running:false};
  save(); updateTimer();
  $("#timerToggle").textContent = "继续专注"; $(".focus-panel").classList.remove("running");
}

$$('.nav-item').forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
$("#newGoal").addEventListener("click", () => openGoalDialog());
$("#saveGoal").addEventListener("click", event => {
  event.preventDefault(); const form = $("#goalForm");
  if (!form.reportValidity()) return;
  if (editingGoalId) updateGoal(form); else generateGoal(form);
  $("#goalDialog").close();
});
$("#goalDialog").addEventListener("close", () => editingGoalId = null);
$("#reviewStart").addEventListener("click", openReviewHub);
$("#newTask").addEventListener("click", () => openTaskDialog());
$("#addQuickTask").addEventListener("click", () => openTaskDialog());
$("#newEvent").addEventListener("click", () => openTaskDialog(null, true));
$("#saveTask").addEventListener("click", event => {
  event.preventDefault(); const form = $("#taskForm"); if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const task = state.tasks.find(item => item.id === editingTaskId);
  const eventMode = task?.isEvent || creatingEvent;
  const startMinutes = parseTime(data.startTime), minutes = Number(data.minutes);
  if (startMinutes !== null && startMinutes + minutes > TIMETABLE_END) return showToast("事件结束时间不能晚于 22:00。");
  if (startMinutes !== null && hasTimeConflict(task?.id || "", data.date, startMinutes, minutes)) return showToast("这个时间已经有安排，请换一个时间。");
  if (task) Object.assign(task, {title:data.title.trim(), date:data.date, minutes, startMinutes, priority:data.priority, goalId:data.goalId});
  else state.tasks.push({id:uid(), title:data.title.trim(), date:data.date, minutes, startMinutes, priority:data.priority, goalId:data.goalId, isEvent:creatingEvent, done:false, doneAt:null, order:nextOrder()});
  save(); render(); $("#taskDialog").close(); showToast(task ? (eventMode ? "事件已更新。" : "任务已更新。") : (eventMode ? "事件已添加。" : "任务已添加。"));
});
$("#taskDialog").addEventListener("close", () => { editingTaskId = null; creatingEvent = false; });
$$('[data-mastery]').forEach(button => button.addEventListener("click", () => completeTask(button.dataset.mastery)));
$("#masteryDialog").addEventListener("close", () => pendingCompletionId = null);
$("#recoverPlan").addEventListener("click", recoverPlans);
$("#prevWeek").addEventListener("click", () => { calendarOffset--; renderCalendar(); });
$("#nextWeek").addEventListener("click", () => { calendarOffset++; renderCalendar(); });
$("#thisWeek").addEventListener("click", () => { calendarOffset = 0; renderCalendar(); });
$("#autoTimetable").addEventListener("click", autoArrangeTimetable);
$$('[data-timetable-days]').forEach(button => button.addEventListener("click", () => {
  timetableDays = Number(button.dataset.timetableDays);
  $$('[data-timetable-days]').forEach(item => item.classList.toggle("active", item === button));
  renderTimetable(Array.from({length:timetableDays}, (_, index) => addDays(today(), index)));
}));
$$('.filter').forEach(button => button.addEventListener("click", () => {
  if (button.dataset.filter === taskFilter) return;
  const filters = ["all","open","done"], bar = $(".filter-bar");
  bar.dataset.direction = filters.indexOf(button.dataset.filter) > filters.indexOf(taskFilter) ? "right" : "left";
  taskFilter = button.dataset.filter; bar.classList.remove("moving"); void bar.offsetWidth; bar.classList.add("moving");
  clearTimeout(bar.motion); bar.motion = setTimeout(() => bar.classList.remove("moving"), 560);
  $$('.filter').forEach(item => item.classList.toggle("active", item === button)); renderAllTasks();
}));
$$('.timer-preset').forEach(button => button.addEventListener("click", () => setTimer(button.dataset.minutes)));
$("#timerCustom").addEventListener("change", event => { setTimer(event.target.value); event.target.value = ""; });
$("#timerToggle").addEventListener("click", () => {
  if (timerHandle) pauseTimer(); else startTimer();
});
$("#timerReset").addEventListener("click", resetTimer);

if (location.hash === "#self-test") {
  const usage = new Map([[`g|${today()}`, 60]]);
  console.assert(chooseScheduleDate({goalId:"g",minutes:30}, {deadline:addDays(today(),2),dailyMinutes:60}, usage) === addDays(today(),1), "智能排期测试失败");
  console.assert([reviewDelay("relearn"), reviewDelay("fuzzy"), reviewDelay("mastered")].join() === "1,3,7", "复习间隔测试失败");
  console.assert(rangesOverlap(540, 60, 570, 30) && !rangesOverlap(540, 30, 570, 30), "时间冲突测试失败");
}

const now = new Date();
$("#dateLabel").textContent = new Intl.DateTimeFormat("zh-CN", {month:"long",day:"numeric",weekday:"long"}).format(now);
document.documentElement.classList.toggle("native-app", Boolean(window.webkit?.messageHandlers?.nativeStore));
render();
$$('.timer-preset').forEach(button => button.classList.toggle("active", Number(button.dataset.minutes) === timerDurationMinutes));
$("#timerHint").textContent = `${timerDurationMinutes} 分钟，只做一件事`;
if (state.timer?.running) timerSeconds <= 0 ? finishTimer() : startTimer(true); else updateTimer();
save();
