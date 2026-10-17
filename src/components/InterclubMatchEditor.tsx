"use client";

// L'ÉDITEUR D'UN SIMPLE (composition, couleurs, jeux, forfait/abandon), sorti de Interclub.tsx
// (audit 2026-10, point 28).

import { Fragment, useState } from "react";
import ColorPicker from "./ColorPicker";
import {
  colorsTooClose,
  describeSequenceProblem,
  playedGames,
  winGamesFor,
  type GameScore,
  UNSET_PLAYER,
} from "@/lib/interclub";
import { compareRosterOrder, isNC, lineupOrderConflict, type OrderedSlot } from "@/lib/interclub-order";
import {
  awayAlignmentClash,
  awayLineupConflict,
  estDesigne,
  type KnownOpponent,
} from "@/lib/interclub-opponents";
import { AUTRE_CLUB, type MatchRow, type RosterEntry } from "./interclub-shared";

export default function MatchEditor({
  match,
  bestOf,
  roster,
  takenBy,
  orderSlots,
  clubOpponents,
  awayLines,
  opponentTeamName,
  teamName,
  recoit,
  busy,
  onCancel,
  onSave,
}: {
  match: MatchRow;
  bestOf: number;
  roster: RosterEntry[];
  /** Joueur déjà aligné → numéro du simple qui le retient, dans CETTE rencontre. */
  takenBy: Map<string, number>;
  /** Simples déjà désignés (hors CELUI-CI), pour griser un choix qui romprait l'ordre. */
  orderSlots: OrderedSlot[];
  /** Les adversaires déjà rencontrés dans CE club — le menu de saisie, à la place d'un champ libre. */
  clubOpponents: KnownOpponent[];
  /** Les adversaires désignés de la rencontre, celui-ci compris — pour vérifier l'ordre d'en face. */
  awayLines: { order: number; awayName: string }[];
  opponentTeamName: string;
  teamName: string;
  /** Notre équipe reçoit-elle ? Sinon, l'adversaire passe en premier dans le formulaire. */
  recoit: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  // "" = non renseigné, sinon `member:<id>` ou `guest:<id>`. Pas de nom libre : la règle du
  // club veut que seuls les joueurs du roster de l'équipe soient alignés, et un joueur sans
  // compte y entre par l'espace admin — pas par une case de texte de cet écran.
  //
  // Le préfixe est nécessaire : rien ne garantit qu'un id de membre et un id d'invité ne se
  // ressemblent pas, et le serveur attend deux champs différents.
  const [pick, setPick] = useState(
    match.homeUserId ? `member:${match.homeUserId}` : match.homeGuestId ? `guest:${match.homeGuestId}` : "",
  );
  const [awayName, setAwayName] = useState(match.awayName === UNSET_PLAYER ? "" : match.awayName);
  /**
   * Le nom d'en face se SAISIT-IL LIBREMENT, ou se choisit-il dans la liste ?
   *
   * Libre par défaut quand on ne connaît personne dans ce club — le cas d'une première rencontre
   * —, et aussi quand le nom déjà posé n'est dans aucune entrée : un nom saisi avant que la
   * liste n'existe ne doit pas disparaître de son propre champ.
   */
  const [awayLibre, setAwayLibre] = useState(
    () =>
      clubOpponents.length === 0 ||
      (estDesigne(match.awayName) && !clubOpponents.some((o) => o.name === match.awayName)),
  );
  const [homeColor, setHomeColor] = useState(match.homeColor ?? "");
  const [awayColor, setAwayColor] = useState(match.awayColor ?? "");
  /**
   * Les points sont gardés en TEXTE, pas en nombre — pour qu'une case vide reste vide.
   *
   * L'état numérique obligeait à choisir une valeur pour « rien saisi », et c'était `0`. Un
   * jeu ajouté s'ouvrait donc sur « 0 – 0 », qui se lit comme un score et non comme une case
   * à remplir : il faut effacer le zéro avant de taper, et un jeu oublié ressemble à un vrai
   * 0-0. La chaîne vide dit ce qu'elle est.
   *
   * La conversion se fait à un seul endroit (`nums`), et une case vide y vaut 0 : c'est
   * exactement ce que faisait l'ancien état, donc rien ne change ni pour la validation ni pour
   * ce qui part au serveur.
   */
  const [games, setGames] = useState<{ home: string; away: string }[]>(
    match.games.map((g) => ({ home: String(g.home), away: String(g.away) })),
  );
  const nums: GameScore[] = games.map((g) => ({
    home: g.home === "" ? 0 : Number(g.home),
    away: g.away === "" ? 0 : Number(g.away),
  }));

  // ⚠️ FIGÉ AU MONTAGE, comme tout ce qui précède — et pour la même raison.
  //
  // C'est le nombre de jeux que CET ÉCRAN a vus, celui qui doit être confronté à la base. Le
  // lire dans la prop `match` au moment du clic annulait la garde : `match` est dérivée de
  // l'état du parent, que `loadFixture` remplace à chaque retour au premier plan et après
  // chaque écriture, tandis que ce formulaire reste monté (aucune `key` ne le recrée) avec son
  // `games` d'origine. Un verrouillage d'écran suffisait donc à rafraîchir la prop sans
  // rafraîchir le formulaire : on envoyait le compte que le serveur allait lui-même lire, la
  // comparaison devenait tautologique, et le jeu saisi entre-temps par quelqu'un d'autre était
  // effacé sans un mot. Le mécanisme serveur était bon ; c'est ce qu'on lui donnait qui ne
  // décrivait plus l'écran.
  const [knownGameCount] = useState(match.games.length);
  const [knownGames] = useState(() => match.games.map((g) => ({ home: g.home, away: g.away })));
  // ISSUE PARTICULIÈRE (audit 2026-10, point 18) : sans elle, un simple où un joueur manque ne
  // se close jamais, ni la rencontre avec lui. « forfait:home » = forfait, NOUS l'emportons.
  const [issue, setIssue] = useState<string>(
    match.outcome && match.outcomeWinner ? `${match.outcome}:${match.outcomeWinner}` : "",
  );
  const [issueKind, issueWinner] = issue ? (issue.split(":") as ["forfait" | "abandon", "home" | "away"]) : [null, null];

  const setGame = (i: number, side: "home" | "away", v: string) => {
    // La case vide est un état légitime, pas une valeur refusée.
    if (v !== "" && !/^\d+$/.test(v)) return;
    setGames((prev) => prev.map((g, k) => (k === i ? { ...g, [side]: v } : g)));
  };

  // Le moteur pur est le MÊME des deux côtés : ce que l'écran refuse, le serveur le refuse
  // aussi, et réciproquement. Un jeu qu'on vient d'ouvrir (0-0) n'est pas une erreur — il est
  // simplement vide, et ne remonte donc aucun message.
  const problem = describeSequenceProblem(nums, bestOf);

  // Un « à désigner » ne doit jamais commencer à jouer : on n'ouvre même pas de nouvelle ligne
  // de score tant que les deux joueurs de CET écran ne sont pas choisis. Le serveur refuse la
  // même chose (`lineupComplete`), mais tendre le bouton pour se le faire refuser ensuite serait
  // un piège — même logique que `takenBy` sur le sélecteur de joueur.
  const lineupUnready = !pick || !awayName.trim();

  // Les AUTRES simples désignés de la rencontre, celui-ci excepté (on le remplace, pas on
  // l'ajoute). Sert à griser, dans le sélecteur, le joueur dont l'alignement romprait l'ordre
  // par classement — même logique que `takenBy` juste au-dessus.
  const otherOrderSlots = orderSlots.filter((s) => s.order !== match.order);

  // Le sélecteur liste le roster du MIEUX classé au MOINS bien, pas alphabétiquement : à
  // classement égal (deux « 5A »), le rang mixte squashnet connu départage, le plus petit en
  // tête ; à défaut, l'ordre alphabétique reçu du serveur suffit (tri stable, cf.
  // `compareRosterOrder`). Refait à chaque rendu plutôt que mémoïsé : le roster est une petite
  // liste, et il change à chaque frappe de `pick`.
  const sortedRoster = [...roster].sort(compareRosterOrder);

  // L'ÉQUIPE QUI REÇOIT EN PREMIER, comme sur la carte du simple (demande du club, 2026-10-09).
  // Les deux blocs sont des VARIABLES et non deux positions CSS : l'ordre de tabulation et celui
  // de la lecture d'écran doivent suivre ce qu'on voit.
  const blocNous = (
    <>
          <label className="ic-field">
            Joueur
            <span className="ic-field-row">
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">— à désigner —</option>
                {sortedRoster.map((r) => {
                  const key = `${r.kind}:${r.id}`;
                  // Comparé au NUMÉRO du simple et non au choix courant : le joueur que ce
                  // simple-ci retient doit rester sélectionnable ici (sinon on ne pourrait plus
                  // revenir en arrière après avoir changé d'avis), mais nulle part ailleurs.
                  const at = takenBy.get(key);
                  const taken = at !== undefined && at !== match.order;
                  // Sans classement connu, un joueur ne peut disputer AUCUN simple — pas seulement
                  // ceux où une comparaison d'ordre est possible. Même logique que `taken` : on
                  // grise plutôt que de laisser composer pour se faire refuser par le serveur.
                  const noClt = r.clt == null;
                  // Sans RANG MIXTE non plus, depuis qu'il départage les joueurs de même classement.
                  // Les NC en sont dispensés : la fédération ne les ordonne pas entre eux.
                  const noRang = !noClt && !isNC(r.clt as string) && r.rangM == null;
                  // Romprait-il l'ordre des simples s'il jouait CELUI-CI ? Même logique que `taken` :
                  // on grise plutôt que de laisser composer pour rien.
                  const orderProblem =
                    taken || noClt || noRang
                      ? null
                      : lineupOrderConflict([
                          ...otherOrderSlots,
                          { order: match.order, name: r.name, clt: r.clt, rangM: r.rangM },
                        ]);
                  const blocked = taken || noClt || noRang || !!orderProblem;
                  return (
                    <option key={key} value={key} disabled={blocked}>
                      {r.name}
                      {/* Le classement ET le rang : ce sont les deux critères qui décident de
                          l'ordre, et le second est le seul moyen de comprendre pourquoi deux « 5A »
                          ne sont pas interchangeables. Un NC montre aussi le sien, à la demande
                          du club : le même pour tous les non-classés, il n'ordonne rien.

                          Noté « 5A #1200 » : le dièse dit « numéro » sans le mot, et une option de
                          `<select>` ne se met pas sur deux lignes — sur un téléphone, « · rang »
                          coûtait quatre caractères par joueur pour ne rien apprendre à personne. */}
                      {r.clt ? ` (${r.clt}${r.rangM != null ? ` #${r.rangM}` : ""})` : ""}
                      {taken
                        ? ` — joue déjà le match n° ${at}`
                        : noClt
                          ? " — classement inconnu"
                          : noRang
                            ? " — rang mixte inconnu"
                            : orderProblem
                              ? " — hors ordre de classement"
                              : ""}
                    </option>
                  );
                })}
              </select>
              <ColorPicker value={homeColor} onChange={setHomeColor} label="Maillot du joueur" />
            </span>
          </label>

          {roster.length === 0 && (
            <p className="notice tiny" role="status">
              Aucun joueur n&apos;est rattaché à {teamName}. Un administrateur compose le roster de
              l&apos;équipe depuis l&apos;espace admin — les membres inscrits sur la page Membres,
              les joueurs sans compte dans la section « Équipes interclub ».
            </p>
          )}
    </>
  );
  const blocEux = (
    <>
          <label className="ic-field">
            Adversaire
            <span className="ic-field-row">
              {awayLibre ? (
                <input
                  value={awayName}
                  onChange={(e) => setAwayName(e.target.value)}
                  placeholder="Nom de l'adversaire"
                  maxLength={40}
                />
              ) : (
                <select
                  value={awayName}
                  onChange={(e) => {
                    if (e.target.value === AUTRE_CLUB) {
                      setAwayLibre(true);
                      setAwayName("");
                    } else {
                      setAwayName(e.target.value);
                    }
                  }}
                >
                  <option value="">— à désigner —</option>
                  {clubOpponents.map((o) => {
                    // UN ADVERSAIRE NE DISPUTE QU'UN SIMPLE, exactement comme nos joueurs. Comparé
                    // au NUMÉRO du simple et non au choix courant : celui que ce simple-ci retient
                    // doit rester sélectionnable ici — sinon on ne pourrait plus revenir en arrière
                    // après avoir changé d'avis — mais nulle part ailleurs.
                    const dejaA = awayAlignmentClash(awayLines, {
                      order: match.order,
                      awayName: o.name,
                    });
                    // LA MÊME RÈGLE QUE POUR NOUS, appliquée aux joueurs d'en face : le mieux classé
                    // dispute le simple n° 1. On grise ici ce que le serveur refuserait, plutôt que
                    // de laisser composer pour se faire refuser à l'enregistrement — même logique
                    // que `takenBy` et `orderProblem` sur le sélecteur juste au-dessus.
                    //
                    // `awayLineupConflict` se tait dès qu'un des désignés nous est inconnu : rien
                    // n'est donc grisé tant que la composition d'en face n'est pas entièrement faite
                    // de joueurs classés. C'est voulu — on ne refuse que ce qu'on sait. Depuis que
                    // le ROSTER fédéral alimente cette liste, ce cas est devenu l'exception plutôt
                    // que la règle : il ne reste que les joueurs qu'aucune inscription ne couvre.
                    //
                    // Inutile de l'évaluer sur un joueur déjà grisé pour doublon : le motif est
                    // acquis, et le message d'ordre le recouvrirait d'une explication moins claire.
                    const conflit =
                      dejaA !== null
                        ? null
                        : awayLineupConflict(
                            awayLines.map((l) =>
                              l.order === match.order ? { order: match.order, awayName: o.name } : l,
                            ),
                            clubOpponents,
                            // `clubOpponents` est déjà filtré sur ce club (cf. plus haut), mais
                            // l'équipe se passe quand même : c'est la MÊME signature que celle du
                            // serveur, et c'est ce qui garantit que l'écran grise exactement ce que
                            // la route refuserait.
                            opponentTeamName,
                          );
                    return (
                      <option
                        key={`${o.team}|${o.name}`}
                        value={o.name}
                        disabled={dejaA !== null || !!conflit}
                      >
                        {o.name}
                        {/* Classement et rang mixte, notés comme pour nous (« 5A #1200 ») : ce sont
                            les deux critères qui décident de l'ordre. Ils viennent du ROSTER publié
                            par la ligue quand on l'a, sinon d'une vérification de capitaine ; à
                            défaut des deux, le joueur reste proposable mais son ordre incontrôlable. */}
                        {o.clt ? ` (${o.clt}${o.rangM != null ? ` #${o.rangM}` : ""})` : ""}
                        {dejaA !== null
                          ? ` — joue déjà le match n° ${dejaA}`
                          : conflit
                            ? " — hors ordre de classement"
                            : ""}
                      </option>
                    );
                  })}
                  <option value={AUTRE_CLUB}>— un autre joueur —</option>
                </select>
              )}
              <ColorPicker value={awayColor} onChange={setAwayColor} label="Maillot de l'adversaire" />
            </span>
          </label>
          {awayLibre && clubOpponents.length > 0 && (
            <button className="ic-linkish" onClick={() => { setAwayLibre(false); setAwayName(""); }}>
              Revenir aux joueurs connus à {opponentTeamName}
            </button>
          )}
          {!awayLibre && clubOpponents.length > 0 && (
            <p className="tiny muted">
              Les joueurs inscrits à {opponentTeamName} chez la ligue, et ceux qu&apos;on a déjà
              rencontrés. Sans classement affiché, le joueur reste proposable, mais l&apos;ordre des
              simples d&apos;en face ne peut pas être contrôlé sur lui.
            </p>
          )}
    </>
  );

  return (
    <div className="ic-editor">
      {recoit ? blocNous : blocEux}
      {recoit ? blocEux : blocNous}

      <label className="ic-field">
        <span className="tiny muted">Issue</span>
        <select value={issue} onChange={(e) => setIssue(e.target.value)} aria-label="Issue du simple">
          <option value="">Match joué</option>
          <option value="forfait:home">Forfait de {opponentTeamName} (nous gagnons)</option>
          <option value="forfait:away">Forfait de notre joueur ({teamName} perd)</option>
          <option value="abandon:home">Abandon de {opponentTeamName} en cours de match</option>
          <option value="abandon:away">Abandon de notre joueur en cours de match</option>
        </select>
      </label>
      {issueKind === "forfait" && (
        <p className="tiny muted ic-games-hint">
          Forfait : le simple se clôt sans jeu, {winGamesFor(bestOf)}-0 pour{" "}
          {issueWinner === "home" ? teamName : opponentTeamName}.
        </p>
      )}

      {issueKind !== "forfait" && (
        <p className="tiny muted ic-games-hint">
          {issueKind === "abandon"
            ? "Jeux TERMINÉS avant l'abandon, dans l'ordre. La victoire est attribuée à l'autre joueur."
            : <>Jeux, dans l&apos;ordre. {winGamesFor(bestOf)} jeux gagnants.</>}
        </p>
      )}
      {issueKind !== "forfait" && games.map((g, i) => (
        <div className="ic-game-row" key={i}>
          <span className="tiny muted">Jeu {i + 1}</span>
          {(recoit ? (["home", "away"] as const) : (["away", "home"] as const)).map((cote, k) => (
            <Fragment key={cote}>
              {k === 1 && <span aria-hidden="true">–</span>}
              <input
                type="number"
                min={0}
                inputMode="numeric"
                value={g[cote]}
                aria-label={`Jeu ${i + 1}, points ${cote === "home" ? "du joueur" : "de l'adversaire"}`}
                onChange={(e) => setGame(i, cote, e.target.value)}
              />
            </Fragment>
          ))}
          <button
            type="button"
            className="secondary ic-game-del"
            onClick={() => setGames((prev) => prev.filter((_, k) => k !== i))}
            aria-label={`Supprimer le jeu ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}

      {issueKind !== "forfait" && games.length < bestOf && (
        <button
          type="button"
          className="secondary ic-add-game"
          disabled={lineupUnready}
          title={lineupUnready ? "Désigne les deux joueurs avant de saisir un score" : undefined}
          onClick={() => setGames((prev) => [...prev, { home: "", away: "" }])}
        >
          + Ajouter un jeu
        </button>
      )}

      {lineupUnready && games.length === 0 && (
        <p className="notice tiny ic-problem" role="status">
          Désigne les deux joueurs avant de saisir un score.
        </p>
      )}

      {colorsTooClose(homeColor, awayColor) && (
        // Avertissement, jamais un blocage : peut-être que les deux équipes jouent VRAIMENT
        // dans des maillots voisins ce soir-là, et l'appli n'a pas à mentir sur le réel.
        <p className="notice tiny ic-problem" role="status">
          Ces deux maillots se ressemblent trop pour se distinguer d&apos;un coup d&apos;œil
          depuis le bord du terrain.
        </p>
      )}

      {problem && (
        <p className="notice error tiny ic-problem" role="alert">
          {problem}
        </p>
      )}

      <div className="modal-actions ic-editor-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          disabled={busy || (issueKind !== "forfait" && !!problem)}
          onClick={() =>
            onSave({
              // Un joueur choisi : le serveur fige son nom d'affichage et vérifie au passage
              // qu'il est bien du roster de l'équipe. Les deux clés partent TOUJOURS ensemble,
              // y compris à `null` — c'est ce qui dit au serveur « la composition est touchée »,
              // et c'est ainsi qu'on revient à « à désigner » (le placeholder est posé
              // là-bas, jamais envoyé d'ici).
              homeUserId: pick.startsWith("member:") ? pick.slice(7) : null,
              homeGuestId: pick.startsWith("guest:") ? pick.slice(6) : null,
              awayName: awayName.trim() || UNSET_PLAYER,
              homeColor: homeColor || null,
              awayColor: awayColor || null,
              // Les lignes vides ou inachevées ne partent pas : `problem` a déjà bloqué les
              // secondes, les premières sont juste des lignes qu'on a ouvertes sans s'en servir.
              // Un forfait part SANS jeu (le serveur refuserait le contraire).
              ...(issueKind === "forfait" ? {} : { games: playedGames(nums) }),
              // L'issue ne part que si elle est posée, ou qu'on en retire une : un simple
              // ordinaire garde exactement le corps d'avant.
              ...(issueKind
                ? { outcome: issueKind, outcomeWinner: issueWinner }
                : match.outcome
                  ? { outcome: null }
                  : {}),
              // Combien de jeux cet écran avait sous les yeux en s'ouvrant. Le serveur refuse
              // d'écrire si la base en compte un autre nombre : entre l'ouverture du
              // formulaire et l'enregistrement, quelqu'un a pu clore un jeu au bord du terrain,
              // et `games` — qui REMPLACE tout — l'effacerait sans que rien ne le signale.
              knownGameCount,
              knownGames,
            })
          }
        >
          Enregistrer
        </button>
      </div>
    </div>
  );
}
