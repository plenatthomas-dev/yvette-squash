import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "./route";

// L'APK DE LA DERNIÈRE RELEASE, SERVI PAR NOTRE DOMAINE.
//
// Un lien github.com est réclamé par l'appli GitHub quand elle est installée, et le
// téléchargement reste alors bloqué dans sa fenêtre (Pixel 8a, 16/10/2026). La route relaie
// donc le fichier : un téléchargement, sous son nom, que le CDN garde une heure.

const RELEASE = "https://github.com/plenatthomas-dev/yvette-squash/releases/latest/download/squash-yvette.apk";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /squash-yvette.apk", () => {
  it("relaie l'APK de la dernière Release, en pièce jointe", async () => {
    const apk = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // « PK.. » : un APK est un zip
    const fetchMock = vi.fn(async () => new Response(apk, { headers: { "Content-Length": "4" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET();

    expect(fetchMock).toHaveBeenCalledWith(RELEASE, expect.anything());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("Content-Disposition")).toContain('filename="squash-yvette.apk"');
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(apk);
  });

  it("renvoie vers GitHub quand la Release ne répond pas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("absent", { status: 404 })));
    const res = await GET();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(RELEASE);
  });

  it("renvoie vers GitHub quand le réseau échoue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const res = await GET();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(RELEASE);
  });
});
