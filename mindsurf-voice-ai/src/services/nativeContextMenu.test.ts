import { beforeEach, describe, expect, it, vi } from "vitest";

const { menuNew, popup } = vi.hoisted(() => ({
  menuNew: vi.fn(),
  popup: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/menu", () => ({
  Menu: {
    new: menuNew.mockResolvedValue({ popup }),
  },
}));

import { installNativeContextMenu } from "./nativeContextMenu";
import { setLocale } from "./i18n";

describe("nativeContextMenu", () => {
  beforeEach(() => {
    setLocale("zh-CN");
    menuNew.mockClear();
    popup.mockClear();
  });
  it("intercepts right-clicks and opens the native edit menu", async () => {
    const target = contextMenuTarget();
    const dispose = installNativeContextMenu(() => false, target);
    const preventDefault = vi.fn();

    target.dispatch({ preventDefault } as unknown as MouseEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(popup).toHaveBeenCalledOnce());
    expect(menuNew).toHaveBeenCalledWith({
      items: [
        { item: "Undo", text: "撤销" },
        { item: "Redo", text: "重做" },
        { item: "Separator" },
        { item: "Cut", text: "剪切" },
        { item: "Copy", text: "复制" },
        { item: "Paste", text: "粘贴" },
        { item: "Separator" },
        { item: "SelectAll", text: "全选" },
      ],
    });
    dispose();
    expect(target.listener).toBeNull();
  });

  it("leaves WebView right-clicks untouched in developer mode", () => {
    const target = contextMenuTarget();
    installNativeContextMenu(() => true, target);
    const preventDefault = vi.fn();

    target.dispatch({ preventDefault } as unknown as MouseEvent);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("builds each menu with the active locale", async () => {
    setLocale("en-US");
    const target = contextMenuTarget();
    installNativeContextMenu(() => false, target);

    target.dispatch({ preventDefault: vi.fn() } as unknown as MouseEvent);

    await vi.waitFor(() => expect(menuNew).toHaveBeenCalledOnce());
    expect(menuNew).toHaveBeenCalledWith({
      items: expect.arrayContaining([{ item: "Copy", text: "Copy" }]),
    });
  });
});

function contextMenuTarget() {
  let listener: ((event: MouseEvent) => void) | null = null;
  return {
    get listener() {
      return listener;
    },
    addEventListener(_type: "contextmenu", next: (event: MouseEvent) => void) {
      listener = next;
    },
    removeEventListener(_type: "contextmenu", current: (event: MouseEvent) => void) {
      if (listener === current) listener = null;
    },
    dispatch(event: MouseEvent) {
      listener?.(event);
    },
  };
}
