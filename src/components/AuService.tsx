/**
 * LE JOUEUR QUI SERT, dans une liste de matchs en cours.
 *
 * ⚠️ PARTAGÉ, parce que deux écrans montrent la même chose : le panneau « En direct » de
 * l'accueil et la fiche d'une rencontre. Deux pastilles pour un même fait finiraient par ne plus
 * se ressembler, et c'est le genre de détail qu'on ne voit qu'une fois les deux côte à côte.
 *
 * CE QU'ELLE CORRIGE. L'information arrivait déjà : `getLiveFixtures` la met dans la charge
 * utile, les deux écrans la déclaraient dans leur type — et aucun des deux ne l'affichait. Or
 * « 7–5 » sans savoir qui sert ne se lit pas. Au squash, le service change de main à chaque
 * échange perdu : c'est lui qui dit si le meneur est en train de conclure ou de subir.
 *
 * UN POINT, ET PAS UNE LETTRE : la place est comptée dans ces lignes (deux noms, un score, un
 * indicateur de couleur de maillot), et un « S » se lirait comme une initiale de joueur. Il se
 * distingue de la pastille de MAILLOT qui le précède — celle-ci est à gauche du nom, pleine et
 * colorée ; celle-là est à droite, petite, et prend l'encre du texte.
 */
export default function AuService() {
  return (
    <span className="ic-au-service" title="Au service">
      <span className="sr-only">au service</span>
    </span>
  );
}
