/** Browser source injected into the trusted management portal script. */
export const runtimePortalJs = String.raw`
  const runtimeUpdates = (() => {
    const storageKey = 'pi-hub-runtime-update';
    const terminalStatuses = new Set(['succeeded', 'failed', 'recovery_required', 'rejected', 'stale']);
    const activeStatuses = new Set(['pending', 'queued', 'running']);
    const jobs = new Map();
    let policy;
    let pending;
    let uncertain = false;
    let polling;
    let submitting = false;
    const stableVersion = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
    const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && validId(saved.id) && stableVersion(saved.version)) pending = { id: saved.id, version: saved.version };
    } catch {}
    function configured() { return auth.runtimeUpdatesAvailable === true; }
    function savePending() {
      try {
        if (pending) {
          const value = JSON.stringify({ id: pending.id, version: pending.version });
          sessionStorage.setItem(storageKey, value);
          return sessionStorage.getItem(storageKey) === value;
        }
        sessionStorage.removeItem(storageKey);
        return sessionStorage.getItem(storageKey) === null;
      } catch { return false; }
    }
    function clearPending() { pending = undefined; uncertain = false; savePending(); }
    function isJob(value) {
      return value && validId(value.id) && stableVersion(value.version) && typeof value.status === 'string' && typeof value.stage === 'string' && Array.isArray(value.targets);
    }
    function remember(value) {
      if (!isJob(value)) return;
      jobs.set(value.id, value);
      if (pending?.id === value.id && terminalStatuses.has(value.status)) clearPending();
    }
    const stageLabel = (stage) => ({
      awaiting_approval: '等待宿主机审批', queued_by_policy: '按策略排队', approved_by_host: '宿主机已批准', policy_changed: '策略已变更',
      preparing: '准备安装', prepared: '安装准备完成', activating: '正在激活新版本', refreshing: '正在刷新受管 Pi 进程',
      waiting_for_idle: '等待忙碌目标空闲', waiting_for_consumer_readiness: '等待共享运行时使用者就绪',
      unmanaged_or_unavailable_consumer: '存在未受管或不可用的共享运行时使用者，需要迁移或检查',
      install_failed: '安装失败', installation_outcome_unknown: '安装结果不确定，需要管理员检查',
      refresh_requires_inspection: '刷新结果需要管理员检查', complete: '任务已完成',
    })[stage] || String(stage || 'unknown').replaceAll('_', ' ');
    const statusLabel = (status) => ({
      pending: '等待处理', queued: '已排队', running: '任务进行中', succeeded: '安装成功；所有受管 Pi 进程已刷新或退出', failed: '安装失败',
      recovery_required: '结果不确定，需要管理员检查', rejected: '任务已拒绝', stale: '任务已过期',
    })[status] || '结果未知';
    const targetLabel = (status) => ({
      waiting_for_idle: '等待目标空闲', refreshing: '正在刷新 Pi 进程', succeeded: '已加载新版本', exited: '已退出',
    })[status] || String(status || 'unknown').replaceAll('_', ' ');
    const reasonLabel = (reason) => ({
      consumer_not_ready: '共享运行时使用者尚未就绪', awaiting_state_change: '等待运行状态变化', busy_race: '空闲确认期间再次忙碌',
    })[reason] || String(reason || '').replaceAll('_', ' ');
    function renderJob(value) {
      const row = document.createElement('div'); row.className = 'runtime-update-result';
      const heading = document.createElement('p'); heading.className = 'runtime-update-heading';
      heading.textContent = 'Pi ' + value.version + ' · ' + statusLabel(value.status);
      const identity = document.createElement('p'); identity.className = 'runtime-update-identity'; identity.textContent = '任务编号：' + value.id;
      const stage = document.createElement('p'); stage.textContent = '阶段：' + stageLabel(value.stage);
      row.append(heading, identity, stage);
      if (value.status === 'pending' && policy?.mode === 'manual') {
        const approval = document.createElement('p'); approval.textContent = '手动策略：请在主机使用 runtime-approve ' + value.id + ' 批准；本页面不会批准更新。'; row.append(approval);
      }
      if (value.status === 'recovery_required' && value.resolved !== true) {
        const unresolved = document.createElement('p'); unresolved.textContent = '此结果尚未解决，将阻止新的运行时更新任务；需要管理员检查并在 Gate 侧解决，本页面不会自动解决。'; row.append(unresolved);
      }
      const visibleTargets = [];
      for (const target of value.targets) if (target?.status !== 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      for (const target of value.targets) if (target?.status === 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      if (value.targets.length > 128) {
        const limit = document.createElement('p'); limit.textContent = '共' + value.targets.length + '个目标记录，仅显示前128条'; row.append(limit);
      }
      for (const target of visibleTargets) {
        if (!target || !validId(target.run_id) || typeof target.status !== 'string') continue;
        const line = document.createElement('p'); line.className = 'runtime-update-target';
        let text = '目标 ' + target.run_id + ' · ' + targetLabel(target.status);
        if (typeof target.old_version === 'string') text += ' · 原版本 ' + target.old_version;
        if (typeof target.version === 'string') text += ' · 当前版本 ' + target.version;
        if (target.status === 'waiting_for_idle' && typeof target.wait_reason === 'string') text += ' · ' + reasonLabel(target.wait_reason);
        line.textContent = text; row.append(line);
      }
      return row;
    }
    function render() {
      const status = get('runtime-update-status');
      const policyNode = get('runtime-update-policy');
      const results = get('runtime-update-results');
      const query = get('runtime-update-query');
      results.replaceChildren(); query.hidden = true;
      if (!configured()) status.textContent = '运行时更新未配置';
      else if (!auth.authorized) status.textContent = '解锁管理后可提交运行时更新';
      else if (!policy) status.textContent = '正在查询运行时更新策略';
      else if (policy.mode === 'disabled') status.textContent = '运行时更新策略已禁用';
      else status.textContent = '运行时更新已就绪';
      policyNode.textContent = !policy ? '' : policy.mode === 'manual' ? '策略：手动审批（manual）' : policy.mode === 'auto' ? '策略：自动执行（auto）' : '策略：已禁用（disabled）';
      if (!auth.authorized) {
        policyNode.textContent = '';
        get('runtime-update-submit').disabled = true;
        return;
      }
      for (const value of jobs.values()) results.append(renderJob(value));
      if (pending && !jobs.has(pending.id)) {
        const unknown = document.createElement('div'); unknown.className = 'runtime-update-result';
        const summary = document.createElement('p'); summary.textContent = 'Pi ' + pending.version + ' · 结果不确定，尚未找到任务；不会重新提交。';
        const identity = document.createElement('p'); identity.textContent = '任务编号：' + pending.id; unknown.append(summary, identity); results.append(unknown);
        query.hidden = !uncertain;
      }
      const active = [...jobs.values()].some((value) => activeStatuses.has(value.status) || (value.status === 'recovery_required' && value.resolved !== true));
      get('runtime-update-submit').disabled = authTransition || !configured() || !policy || policy.mode === 'disabled' || active || !!pending || submitting;
    }
    async function lookupPending() {
      if (!pending || !auth.authorized || !configured()) return;
      const generation = authGeneration;
      const identity = pending;
      try {
        const result = await api('runtime-updates/' + identity.id);
        if (generation !== authGeneration || pending !== identity) return;
        if (isJob(result) && result.id === identity.id && result.version === identity.version) { uncertain = false; remember(result); }
        else { uncertain = true; notice('任务查询响应不完整；将保留原任务编号继续查询，不会重新提交。'); }
      } catch (error) {
        if (generation !== authGeneration || pending !== identity) return;
        uncertain = true;
        if (error.status !== 404) notice('暂时无法确认运行时更新任务；请保留任务编号并稍后按原编号查询。');
      }
      render();
    }
    async function poll() {
      const generation = authGeneration;
      if (polling === generation || !auth.authorized || !configured()) return;
      polling = generation;
      try {
        const result = await api('runtime-updates');
        if (generation !== authGeneration) return;
        policy = result?.policy && ['manual', 'auto', 'disabled'].includes(result.policy.mode) ? { mode: result.policy.mode } : undefined;
        jobs.clear();
        for (const value of [...(Array.isArray(result?.jobs) ? result.jobs : []), ...(Array.isArray(result?.active) ? result.active : [])].slice(0, 128)) remember(value);
        if (pending && !jobs.has(pending.id)) await lookupPending();
      } catch { if (generation === authGeneration) notice('暂时无法查询运行时更新状态。'); }
      finally { if (polling === generation) polling = undefined; if (generation === authGeneration) render(); }
    }
    get('runtime-update-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (get('runtime-update-submit').disabled) return;
      const version = get('runtime-update-version').value.trim();
      if (!stableVersion(version)) { notice('请输入精确稳定版本，例如 1.3.0；不接受 latest、范围、预发布版或构建标记。'); return; }
      const manual = policy?.mode === 'manual' ? '\n当前是手动策略；提交后仍需主机管理员使用 runtime-approve 批准。' : '';
      if (!window.confirm('确认向 Gate 提交 Pi ' + version + ' 的全局运行时更新任务？\n这会影响所有共享运行时使用者；忙碌目标会等待空闲，不会被强制中断。\n旧镜像中的使用者需要先迁移到受管运行环境。\n本页面只创建任务，不批准更新。' + manual)) return;
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('');
      pending = { id, version }; uncertain = true; submitting = true;
      if (!savePending()) {
        pending = undefined; uncertain = false; submitting = false;
        notice('未提交运行时更新：浏览器会话存储无法保存任务编号，请恢复存储后重试。'); render(); return;
      }
      render();
      const generation = authGeneration;
      try {
        const result = await api('runtime-updates', { version, idempotencyKey: id });
        if (generation !== authGeneration) return;
        if (isJob(result) && result.id === id && result.version === version) {
          uncertain = false; remember(result); notice('运行时更新任务已提交。请按任务编号监控安装与空闲等待。');
        } else {
          uncertain = true; notice('提交响应不完整，将按原任务编号查询；不会自动再次提交。');
        }
      } catch (error) {
        if (generation !== authGeneration) return;
        if (error.status === 400) { clearPending(); notice('版本无效或尚未通过审计；请输入 Gate 已审计的精确稳定版本。'); }
        else if (error.status === 409) { clearPending(); notice('Gate 正在处理其他任务，或运行时更新策略已禁用。'); }
        else notice('未收到确定的提交结果，将按原任务编号查询；不会自动再次提交。');
      } finally {
        submitting = false; render();
        if (generation === authGeneration) {
          if (pending && uncertain) await lookupPending();
          else if (!pending) await poll();
        }
      }
    });
    get('runtime-update-query').addEventListener('click', async () => { await lookupPending(); });
    function updateAuth() { render(); }
    function clearProtected() { jobs.clear(); policy = undefined; render(); }
    return { updateAuth, clearProtected, poll };
  })();
`;
