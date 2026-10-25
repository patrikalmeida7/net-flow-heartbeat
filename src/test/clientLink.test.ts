import { describe, it, expect } from "vitest";
import { clientPath, pageInfo } from "@/lib/clientLink";

describe("clientPath", () => {
  it("logins iguais em concentradores diferentes geram links diferentes", () => {
    expect(clientPath("c1", "joao")).not.toBe(clientPath("c2", "joao"));
    expect(clientPath("c1", "joão silva")).toBe("/pppoe/c/c1/jo%C3%A3o%20silva");
  });
});

describe("pageInfo", () => {
  it("calcula intervalo e total de páginas sem truncar", () => {
    expect(pageInfo(259, 5, 50)).toEqual({ pages: 6, page: 5, offset: 250, from: 251, to: 259 });
  });
  it("página fora do intervalo é ajustada", () => {
    expect(pageInfo(10, 9, 50).page).toBe(0);
  });
  it("total zero", () => {
    expect(pageInfo(0, 0, 50)).toEqual({ pages: 1, page: 0, offset: 0, from: 0, to: 0 });
  });
});
