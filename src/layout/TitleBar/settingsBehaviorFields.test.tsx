//! Regression coverage for image-paste setting visibility and availability: every window sees the setting, but
//! only the desktop shell running on the same machine as the agent can select native image paste.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { env, invoke, setMode, setDynamicStatusFilter } = vi.hoisted(() => ({
  env: {
    isTauri: false,
    isElectron: false,
  },
  invoke: vi.fn(),
  setMode: vi.fn(),
  setDynamicStatusFilter: vi.fn(),
}));

vi.mock("../../i18n", () => ({
  useT: () => (key: string) => key,
  getLangChoice: () => "auto",
  LOCALE_NAMES: {},
  LOCALES: [],
  setLang: vi.fn(),
}));
vi.mock("../../platform", () => ({ env }));
vi.mock("../../store/termStore", () => ({
  useTermStore: (selector: (state: object) => unknown) =>
    selector({
      accent: "auto",
      density: "regular",
      paneStyle: "flush",
      dividerStyle: "subtle",
      navLayout: "tree",
      singleTabMode: true,
      spawnConfirm: true,
      termRenderer: "dom",
      redrawOnReveal: false,
      outputScheduler: true,
      dynamicStatusFilter: true,
      recordSessions: false,
      maxLiveTabs: 32,
      usageRefreshSec: 300,
      soundEnabled: true,
      notifyEnabled: true,
      cleanPastedImages: true,
      uiFontFamily: null,
      uiFontSize: null,
      termFontFamily: null,
      termFontSize: 13,
      imagePasteMode: "upload",
      setImagePasteMode: setMode,
      setAccent: vi.fn(),
      setDensity: vi.fn(),
      setPaneStyle: vi.fn(),
      setDividerStyle: vi.fn(),
      setNavLayout: vi.fn(),
      setSingleTabMode: vi.fn(),
      setSpawnConfirm: vi.fn(),
      setTermRenderer: vi.fn(),
      setRedrawOnReveal: vi.fn(),
      setOutputScheduler: vi.fn(),
      setDynamicStatusFilter,
      setRecordSessions: vi.fn(),
      setMaxLiveTabs: vi.fn(),
      setUsageRefreshSec: vi.fn(),
      toggleSound: vi.fn(),
      setCleanPastedImages: vi.fn(),
      toggleNotify: vi.fn(),
      setUiFontFamily: vi.fn(),
      setUiFontSize: vi.fn(),
      setTermFontFamily: vi.fn(),
      setTermFontSize: vi.fn(),
    }),
}));
vi.mock("../../ipc/commands", () => ({
  cleanPastedImages: vi.fn(),
  spawnSkillsInstalled: vi.fn().mockResolvedValue(false),
  installSpawnSkills: vi.fn(),
  listShells: vi.fn().mockResolvedValue([]),
  giteaGetStatus: vi.fn(),
  giteaProbe: vi.fn(),
  giteaSetConfig: vi.fn(),
}));
vi.mock("../../ipc/settingsSync", () => ({ pushSetting: vi.fn() }));
vi.mock("../../ipc/transport", () => ({ invoke, isTauri: false, isRemoteWindow: false }));
vi.mock("../../notify", () => ({
  getEffectiveNotifyPermission: vi.fn().mockResolvedValue("unsupported"),
  requestEffectiveNotifyPermission: vi.fn().mockResolvedValue("unsupported"),
}));

import { ImagePasteModeField } from "./settingsBehaviorFields";
import { HeddleCoreRootField } from "./settingsPanels";
import { SettingsModal } from "./SettingsModal";
import { loadSettings, SETTINGS_KEY } from "../../store/settings";

afterEach(() => {
  cleanup();
  env.isTauri = false;
  env.isElectron = false;
  setMode.mockReset();
  setDynamicStatusFilter.mockReset();
  invoke.mockReset();
});

describe("image paste settings", () => {
  it("a browser or remote window still shows both modes, with the native one disabled", () => {
    render(<ImagePasteModeField />);
    expect(screen.getByText("settings.imagePasteMode")).toBeTruthy();
    expect(screen.getByText("settings.imagePasteUpload")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "settings.imagePasteAgent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("settings.imagePasteRemoteHint")).toBeTruthy();
  });

  it("a local Tauri window can select native image paste", () => {
    env.isTauri = true;
    render(<ImagePasteModeField />);
    expect(
      (screen.getByRole("button", { name: "settings.imagePasteAgent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.getByText("settings.imagePasteHint")).toBeTruthy();
  });

  it("the Terminal category of the full settings dialog always contains the image paste entry", () => {
    render(<SettingsModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "settings.catTerminal" }));
    expect(screen.getByText("settings.imagePasteMode")).toBeTruthy();
    expect(screen.getByText("settings.imagePasteUpload")).toBeTruthy();
    expect(screen.getByText("settings.imagePasteAgent")).toBeTruthy();
  });

  it("dynamic additions to the status filter are on by default and can be turned off in the behaviour settings", () => {
    const previous = localStorage.getItem(SETTINGS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    expect(loadSettings().dynamicStatusFilter).toBe(true);
    if (previous === null) localStorage.removeItem(SETTINGS_KEY);
    else localStorage.setItem(SETTINGS_KEY, previous);

    render(<SettingsModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "settings.catBehavior" }));
    const label = screen.getByText("settings.dynamicStatusFilter");
    const field = label.parentElement;
    expect(field).toBeTruthy();
    fireEvent.click(within(field as HTMLElement).getByRole("button", { name: "common.off" }));
    expect(setDynamicStatusFilter).toHaveBeenCalledWith(false);
  });
});

describe("heddle core path setting", () => {
  it("loads the saved path and removes it from vlx-settings when cleared", async () => {
    invoke.mockResolvedValueOnce({
      "vlx-settings": JSON.stringify({ comms: { heddleCoreRoot: "~/Developer/heddle" } }),
    });
    invoke.mockResolvedValueOnce(undefined);

    render(<HeddleCoreRootField />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("~/Developer/heddle"));

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith("set_app_settings", {
        entries: { "vlx-settings": "{}" },
      }),
    );
  });
});
