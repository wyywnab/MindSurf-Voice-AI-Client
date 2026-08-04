import { afterEach, describe, expect, it, vi } from "vitest";

const { menuNew, setAsAppMenu, submenuNew, windowMenu, helpMenu, closePrevious } =
  vi.hoisted(() => ({
    menuNew: vi.fn(),
    setAsAppMenu: vi.fn(),
    submenuNew: vi.fn(),
    windowMenu: { setAsWindowsMenuForNSApp: vi.fn() },
    helpMenu: { setAsHelpMenuForNSApp: vi.fn() },
    closePrevious: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: menuNew },
  Submenu: { new: submenuNew },
}));

import { syncMacOSAppMenu } from "./appMenu";
import { setLocale } from "./i18n";

describe("appMenu", () => {
  afterEach(() => {
    setLocale("zh-CN");
    vi.unstubAllGlobals();
  });

  it("builds a localized macOS menu with every application page", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
    submenuNew.mockResolvedValueOnce(windowMenu).mockResolvedValueOnce(helpMenu);
    setAsAppMenu.mockResolvedValue({ close: closePrevious });
    menuNew.mockResolvedValue({ setAsAppMenu });
    const onNavigate = vi.fn();
    setLocale("en-US");

    await syncMacOSAppMenu({ diagnosticsEnabled: false, onNavigate });

    expect(submenuNew).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "window-menu", text: "Window" }),
    );
    expect(submenuNew).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "help-menu", text: "Help" }),
    );
    const menuOptions = menuNew.mock.calls[0]?.[0] as {
      items: Array<{ id?: string; items?: Array<Record<string, unknown>> }>;
    };
    const editMenu = menuOptions.items.find((item) => item.id === "edit-menu");
    expect(editMenu?.items).toEqual(
      expect.arrayContaining([{ item: "Copy", text: "Copy" }]),
    );
    const pagesMenu = menuOptions.items.find((item) => item.id === "pages-menu");
    expect(pagesMenu?.items?.map((item) => item.id)).toEqual([
      "app-page-record",
      "app-page-permissions",
      "app-page-diagnostics",
      "app-page-settings",
    ]);
    expect(pagesMenu?.items?.[2]).toMatchObject({
      text: "Diagnostics",
      enabled: false,
    });
    (pagesMenu?.items?.[1]?.action as () => void)();
    expect(onNavigate).toHaveBeenCalledWith("permissions");
    expect(windowMenu.setAsWindowsMenuForNSApp).toHaveBeenCalledOnce();
    expect(helpMenu.setAsHelpMenuForNSApp).toHaveBeenCalledOnce();
    expect(closePrevious).toHaveBeenCalledOnce();
  });
});
