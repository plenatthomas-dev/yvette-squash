// « POPULU AXEL » → « Populu Axel ». Le nom fédéral est en capitales ; on ne crie pas.
//
// Dans un module à lui, sans dépendance : les écrans en ont besoin, et l'importer depuis
// `interclub-stats.ts` tirait dans le paquet du navigateur toute la lecture squashnet.
export function nomLisible(fedName: string): string {
  return fedName
    .trim()
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}
