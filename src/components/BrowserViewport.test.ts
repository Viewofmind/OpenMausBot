import { describe, expect, it, vi } from "vitest";
import { createBrowserPressedInputs } from "./BrowserViewport";

const key = (eventType: string, value = "a", modifiers = 0) => ({
  type: "input_keyboard", eventType, key: value, code: value === "Shift" ? "ShiftLeft" : "KeyA", modifiers,
  ...(eventType === "keyDown" && value.length === 1 ? { text: value } : {}),
});

describe("browser focus-loss cleanup", () => {
  it("does not repeat normal text or already released keys on blur", () => {
    const input = vi.fn();
    const pressed = createBrowserPressedInputs(input);
    pressed.send(key("keyDown")); pressed.send(key("keyUp"));
    pressed.send({ type: "input_keyboard", eventType: "char", text: "pasted text" });
    pressed.release(); pressed.release();
    expect(input.mock.calls.map(([body]) => body)).toEqual([
      key("keyDown"), key("keyUp"), { type: "input_keyboard", eventType: "char", text: "pasted text" },
    ]);
  });

  it("releases held printable keys and modifiers exactly once without text", () => {
    const input = vi.fn();
    const pressed = createBrowserPressedInputs(input);
    pressed.send(key("keyDown", "Shift", 8));
    pressed.send(key("keyDown", "A", 8)); pressed.send(key("keyDown", "A", 8));
    pressed.release(); pressed.release();
    expect(input.mock.calls.slice(3).map(([body]) => body)).toEqual([
      key("keyUp", "A"), key("keyUp", "Shift"),
    ]);
  });

  it("releases the actual held mouse buttons at the last drag position", () => {
    const input = vi.fn();
    const pressed = createBrowserPressedInputs(input);
    const button = (eventType: string, name: string) => ({ type: "input_mouse", eventType, button: name, x: 5, y: 6 });
    pressed.send(button("mousePressed", "right")); pressed.send(button("mousePressed", "middle"));
    pressed.send(button("mouseReleased", "middle"));
    pressed.send({ type: "input_mouse", eventType: "mouseMoved", button: "right", x: 25, y: 30 });
    pressed.release();
    expect(input).toHaveBeenCalledTimes(5);
    expect(input).toHaveBeenLastCalledWith({ ...button("mouseReleased", "right"), x: 25, y: 30, modifiers: 0 });
  });
});
