import assert from "node:assert/strict";
import { apply, inject } from "../lib/index.js";

// 测试 tools/pre-execute 钩子对 create_skill 的审批与沙箱策略感知

let preExecuteHandler = null;
let registeredTool = null;

const rawCtx = {
  effect(fn) {
    return fn();
  },
  on(event, handler) {
    if (event === "tools/pre-execute") {
      preExecuteHandler = handler;
      return () => {
        if (preExecuteHandler === handler) preExecuteHandler = null;
      };
    }
  },
  tools: {
    register(tool) {
      registeredTool = tool;
      return () => {};
    },
  },
  skills: {
    registerProvider() {
      return () => {};
    },
  },
  connection: {
    fetch: {
      register() {
        return () => {};
      },
    },
  },
  sessions: {
    list() {
      return [];
    },
  },
  get(name) {
    if (name === "sandboxPolicy") return rawCtx.sandboxPolicy;
    if (name === "sessionProjections") return rawCtx.sessionProjections;
    return undefined;
  },
};

const builtinContextProps = new Set(["effect", "on", "get", "logger", "emit"]);

// 模拟严格的 Cordis Context Proxy：未声明在 inject 中的服务直接以属性读取时必定抛错
const fakeCtx = new Proxy(rawCtx, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && !builtinContextProps.has(prop)) {
      if (!inject.includes(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      }
    }
    return Reflect.get(target, prop, receiver);
  },
});

apply(fakeCtx);

assert.ok(preExecuteHandler, "tools/pre-execute 钩子必须被注册");
assert.ok(!inject.includes("sandboxPolicy"), "sandboxPolicy 不作为全插件硬依赖注入，通过反射安全获取");

// 用例 1：受限制沙箱（如 workspace-write）下调用 create_skill，必须返回 ask 请求审批
{
  let nextCalled = false;
  rawCtx.sandboxPolicy = {
    resolve() {
      return { mode: "workspace-write", workspaceRoot: "/workspace" };
    },
  };
  const exec = {
    name: "create_skill",
    arguments: { name: "test-skill", description: "desc", body: "body" },
    agent: {
      session: { id: "s1", header: { cwd: "/workspace" } },
    },
  };
  const decision = await preExecuteHandler(exec, () => {
    nextCalled = true;
    return Promise.resolve({ kind: "allow" });
  });

  assert.equal(nextCalled, false, "workspace-write 下不得跳过审批直接执行 next()");
  assert.equal(decision.kind, "ask", "workspace-write 下应拦截并返回 ask");
  assert.equal(decision.reason, "Create a new skill under DSH_HOME/skills");
  assert.equal(decision.displayReason?.zh, "在 DSH_HOME/skills 目录下创建新技能");
}

// 用例 2：danger-full-access 沙箱下调用 create_skill，必须直接放行（调用 next()）
{
  let nextCalled = false;
  rawCtx.sandboxPolicy = {
    resolve() {
      return { mode: "danger-full-access", workspaceRoot: "/workspace" };
    },
  };
  const exec = {
    name: "create_skill",
    arguments: { name: "test-skill-2", description: "desc", body: "body" },
    agent: {
      session: { id: "s2", header: { cwd: "/workspace" } },
    },
  };
  const decision = await preExecuteHandler(exec, () => {
    nextCalled = true;
    return Promise.resolve({ kind: "allow" });
  });

  assert.equal(nextCalled, true, "danger-full-access 下必须调用 next() 放行");
  assert.deepEqual(decision, { kind: "allow" }, "danger-full-access 下返回 next() 的结果");
}

// 用例 3：通过 sessionProjections 识别到 danger-full-access
{
  let nextCalled = false;
  rawCtx.sandboxPolicy = undefined;
  rawCtx.sessionProjections = {
    stateOf(session, key) {
      if (key === "sandboxMode") return "danger-full-access";
      return undefined;
    },
  };
  const exec = {
    name: "create_skill",
    arguments: { name: "test-skill-3", description: "desc", body: "body" },
    agent: {
      session: { id: "s3" },
    },
  };
  const decision = await preExecuteHandler(exec, () => {
    nextCalled = true;
    return Promise.resolve({ kind: "allow" });
  });

  assert.equal(nextCalled, true, "sessionProjections 中的 danger-full-access 必须放行");
  assert.deepEqual(decision, { kind: "allow" });
}

// 用例 4：服务均缺失（无 sandboxPolicy / 无 sessionProjections）时必须 fail-closed 拦截并返回 ask
{
  let nextCalled = false;
  rawCtx.sandboxPolicy = undefined;
  rawCtx.sessionProjections = undefined;
  const exec = {
    name: "create_skill",
    arguments: { name: "test-skill-missing", description: "desc", body: "body" },
  };
  const decision = await preExecuteHandler(exec, () => {
    nextCalled = true;
    return Promise.resolve({ kind: "allow" });
  });

  assert.equal(nextCalled, false, "策略服务缺失时不得放行，必须 fail-closed 请求审批");
  assert.equal(decision?.kind, "ask");
}

// 用例 5：其他非 create_skill 工具直接放行
{
  let nextCalled = false;
  const exec = {
    name: "other_tool",
  };
  const decision = await preExecuteHandler(exec, () => {
    nextCalled = true;
    return Promise.resolve({ kind: "allow" });
  });

  assert.equal(nextCalled, true, "非 create_skill 工具必须直接放行");
  assert.deepEqual(decision, { kind: "allow" });
}

// 用例 6：通过 session.header.sandboxMode 识别到 danger-full-access
{
  let nextCalled = false;
  rawCtx.sandboxPolicy = undefined;
  rawCtx.sessionProjections = undefined;
  const exec = {
    name: "create_skill",
    arguments: { name: "test-skill-header", description: "desc", body: "body" },
    agent: {
      session: {
        id: "s-header",
        header: { sandboxMode: "danger-full-access" },
      },
    },
  };
  const decision = await preExecuteHandler(exec, () => {
    nextCalled = true;
    return Promise.resolve({ kind: "allow" });
  });

  assert.equal(nextCalled, true, "session.header.sandboxMode 为 danger-full-access 时必须放行");
  assert.deepEqual(decision, { kind: "allow" });
}

console.log("create-skill-approval tests passed");
