function fail(code, message) { return Object.assign(new Error(message), { code }); }

// SDK APIs verified against UI-TARS-desktop packages/ui-tars/sdk and operators/nut-js.
export function createUITarsOperator(config = {}) {
  let agent;
  const redact = message => config.apiKey ? String(message).split(config.apiKey).join('[REDACTED]') : String(message);
  return {
    stop() { agent?.stop(); agent?.resume(); },
    async run(instruction, { signal, onAction, onData = () => {} }) {
      if (!config.baseURL || !config.apiKey || !config.model) throw fail('unconfigured', '尚未配置 UI-TARS 视觉模型：需要 GUI_BASE_URL、GUI_API_KEY、GUI_MODEL。');
      if (typeof onAction !== 'function') throw fail('permission_gate_missing', '电脑执行器必须连接权限审批门。');
      let GUIAgent, NutJSOperator, StatusEnum;
      try {
        ({ GUIAgent, StatusEnum } = await import('@ui-tars/sdk'));
        ({ NutJSOperator } = await import('@ui-tars/operator-nut-js'));
      } catch (error) { throw fail('dependency_unavailable', `UI-TARS 本机依赖不可用：${error.message}`); }
      if (signal.aborted) throw fail('task_interrupted', '任务已打断。');
      let lastScreenshot;
      let executionError;
      class GuardedOperator extends NutJSOperator {
        async screenshot() {
          if (signal.aborted) throw fail('task_interrupted', '任务已打断。');
          const result = await super.screenshot();
          lastScreenshot = result.base64;
          onData({ kind: 'observed', text: '已重新观察当前屏幕。' });
          return result;
        }
        async execute(params) {
          const type = params.parsedPrediction?.action_type;
          if (type === 'user_stop') return { status: StatusEnum.USER_STOPPED };
          if (signal.aborted) throw fail('task_interrupted', '任务已打断。');
          if (executionError) throw executionError;
          if (type === 'finished') return { status: StatusEnum.END };
          if (type === 'call_user') return { status: StatusEnum.CALL_USER };
          // shortcut: coordinates cannot prove app identity or transaction meaning; require per-action review until a trusted semantic adapter exists.
          const observed = lastScreenshot;
          try {
            return await onAction({ kind: 'gui', opaque: true, type, description: `UI-TARS 原始输入：${type}`, detail: redact(JSON.stringify(params.parsedPrediction?.action_inputs || {})) }, async () => {
              if (signal.aborted) throw fail('task_interrupted', '任务已打断。');
              const current = await super.screenshot();
              if (signal.aborted) throw fail('task_interrupted', '任务已打断。');
              if (!observed || current.base64 !== observed) throw fail('screen_changed', '审批期间屏幕发生变化，已阻止执行旧坐标；请回到目标应用后重新下达任务。');
              return super.execute(params);
            });
          } catch (error) {
            executionError = error;
            agent?.stop();
            throw error;
          }
        }
      }
      let lastStatus;
      let sdkError;
      agent = new GUIAgent({
        model: { baseURL: config.baseURL, apiKey: config.apiKey, model: config.model },
        ...(config.uiTarsVersion ? { uiTarsVersion: config.uiTarsVersion } : {}),
        operator: new GuardedOperator(), signal,
        maxLoopCount: Number.isInteger(config.maxLoopCount) && config.maxLoopCount >= 1 && config.maxLoopCount <= 100 ? config.maxLoopCount : 25,
        retry: { model: { maxRetries: 0 }, screenshot: { maxRetries: 0 }, execute: { maxRetries: 0 } },
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        onData: ({ data }) => { lastStatus = data.status; onData({ kind: 'model_status', status: data.status }); },
        onError: ({ error }) => { sdkError = error; },
      });
      const stop = () => { agent.stop(); agent.resume(); };
      signal.addEventListener('abort', stop, { once: true });
      try {
        await agent.run(instruction);
        if (signal.aborted) throw fail('task_interrupted', '任务已打断。');
        if (executionError) throw executionError;
        if (sdkError) throw fail('operator_failed', redact(sdkError.message || 'UI-TARS 执行失败。'));
        if (lastStatus !== StatusEnum.END) throw fail(lastStatus === StatusEnum.CALL_USER ? 'user_action_required' : 'operator_incomplete', `UI-TARS 未完成任务（${lastStatus || '无完成状态'}）。`);
      } catch (error) {
        throw fail(error.code || 'operator_failed', redact(error.message || 'UI-TARS 执行失败。'));
      } finally { signal.removeEventListener('abort', stop); agent = undefined; }
    },
  };
}
