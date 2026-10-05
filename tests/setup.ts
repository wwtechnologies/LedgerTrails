import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
