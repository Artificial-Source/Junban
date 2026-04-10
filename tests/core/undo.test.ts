import { describe, it, expect, vi } from "vitest";
import { UndoManager, type UndoableAction } from "../../src/core/undo.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAction(desc: string, log: string[]): UndoableAction {
  return {
    description: desc,
    execute: vi.fn(async () => {
      log.push(`exec:${desc}`);
    }),
    undo: vi.fn(async () => {
      log.push(`undo:${desc}`);
    }),
  };
}

describe("UndoManager", () => {
  it("performs an action", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];
    const action = createAction("a", log);

    await mgr.perform(action);
    expect(log).toEqual(["exec:a"]);
    expect(mgr.canUndo()).toBe(true);
    expect(mgr.canRedo()).toBe(false);
  });

  it("undoes and redoes an action", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];
    const action = createAction("a", log);

    await mgr.perform(action);
    const undone = await mgr.undo();

    expect(undone).toBe(action);
    expect(log).toEqual(["exec:a", "undo:a"]);
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(true);

    const redone = await mgr.redo();
    expect(redone).toBe(action);
    expect(log).toEqual(["exec:a", "undo:a", "exec:a"]);
  });

  it("returns null when nothing to undo/redo", async () => {
    const mgr = new UndoManager();
    expect(await mgr.undo()).toBeNull();
    expect(await mgr.redo()).toBeNull();
  });

  it("clears redo stack on new perform", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];

    await mgr.perform(createAction("a", log));
    await mgr.undo();
    expect(mgr.canRedo()).toBe(true);

    await mgr.perform(createAction("b", log));
    expect(mgr.canRedo()).toBe(false);
  });

  it("respects max stack depth (50)", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];

    for (let i = 0; i < 60; i++) {
      await mgr.perform(createAction(`${i}`, log));
    }

    // Should only be able to undo 50 times
    let count = 0;
    while (mgr.canUndo()) {
      await mgr.undo();
      count++;
    }
    expect(count).toBe(50);
  });

  it("notifies subscribers", async () => {
    const mgr = new UndoManager();
    const listener = vi.fn();
    mgr.subscribe(listener);

    await mgr.perform(createAction("a", []));
    expect(listener).toHaveBeenCalledTimes(1);

    await mgr.undo();
    expect(listener).toHaveBeenCalledTimes(2);

    await mgr.redo();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("allows unsubscribe", async () => {
    const mgr = new UndoManager();
    const listener = vi.fn();
    const unsub = mgr.subscribe(listener);

    await mgr.perform(createAction("a", []));
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    await mgr.perform(createAction("b", []));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping perform and undo calls", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];
    const executeGate = createDeferred<void>();

    const action: UndoableAction = {
      description: "a",
      execute: vi.fn(async () => {
        log.push("exec:start");
        await executeGate.promise;
        log.push("exec:end");
      }),
      undo: vi.fn(async () => {
        log.push("undo:a");
      }),
    };

    const performPromise = mgr.perform(action);
    const undoPromise = mgr.undo();

    executeGate.resolve();
    await performPromise;
    const undone = await undoPromise;

    expect(undone).toBe(action);
    expect(log).toEqual(["exec:start", "exec:end", "undo:a"]);
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(true);
  });

  it("serializes overlapping undo and redo calls", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];
    const undoGate = createDeferred<void>();

    const actionA = createAction("a", log);
    const actionB: UndoableAction = {
      description: "b",
      execute: vi.fn(async () => {
        log.push("exec:b");
      }),
      undo: vi.fn(async () => {
        log.push("undo:b:start");
        await undoGate.promise;
        log.push("undo:b:end");
      }),
    };

    await mgr.perform(actionA);
    await mgr.perform(actionB);

    const undoPromise = mgr.undo();
    const redoPromise = mgr.redo();

    undoGate.resolve();

    const undone = await undoPromise;
    const redone = await redoPromise;

    expect(undone).toBe(actionB);
    expect(redone).toBe(actionB);
    expect(log).toEqual(["exec:a", "exec:b", "undo:b:start", "undo:b:end", "exec:b"]);
    expect(mgr.canUndo()).toBe(true);
    expect(mgr.canRedo()).toBe(false);
  });

  it("serializes overlapping perform calls", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];
    const executeGate = createDeferred<void>();

    const actionA: UndoableAction = {
      description: "a",
      execute: vi.fn(async () => {
        log.push("exec:a:start");
        await executeGate.promise;
        log.push("exec:a:end");
      }),
      undo: vi.fn(async () => {
        log.push("undo:a");
      }),
    };
    const actionB: UndoableAction = {
      description: "b",
      execute: vi.fn(async () => {
        log.push("exec:b");
      }),
      undo: vi.fn(async () => {
        log.push("undo:b");
      }),
    };

    const performA = mgr.perform(actionA);
    const performB = mgr.perform(actionB);

    executeGate.resolve();
    await performA;
    await performB;

    expect(log).toEqual(["exec:a:start", "exec:a:end", "exec:b"]);

    await mgr.undo();
    await mgr.undo();
    expect(log).toEqual(["exec:a:start", "exec:a:end", "exec:b", "undo:b", "undo:a"]);
  });

  it("continues processing queued operations after a failure", async () => {
    const mgr = new UndoManager();
    const log: string[] = [];
    const failGate = createDeferred<void>();
    const error = new Error("execute failed");

    const failingAction: UndoableAction = {
      description: "fail",
      execute: vi.fn(async () => {
        log.push("exec:fail:start");
        await failGate.promise;
        log.push("exec:fail:error");
        throw error;
      }),
      undo: vi.fn(async () => {
        log.push("undo:fail");
      }),
    };

    const succeedingAction = createAction("ok", log);

    const failingPerform = mgr.perform(failingAction);
    const succeedingPerform = mgr.perform(succeedingAction);

    failGate.resolve();

    await expect(failingPerform).rejects.toThrow("execute failed");
    await succeedingPerform;

    expect(log).toEqual(["exec:fail:start", "exec:fail:error", "exec:ok"]);
    expect(mgr.canUndo()).toBe(true);
    expect(mgr.canRedo()).toBe(false);

    const undone = await mgr.undo();
    expect(undone).toBe(succeedingAction);
    expect(mgr.canRedo()).toBe(true);
  });
});
