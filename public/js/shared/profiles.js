// Profils de machine, partagés entre le serveur et le navigateur.
//
// firmware : dialecte parlé par la carte.
//   grbl     : Grbl 1.1 / grblHAL (commandes temps réel, $J=, $$…).
//   smoothie : Smoothieware, dont le firmware Darkly Labs de l'Emblaser 2.
// laser : interface laser (puissance au lieu de la broche, pas de palpage,
//   pas de montée en Z de sécurité, tir de repérage, gravure d'image).
// sMax : valeur S qui correspond à 100 % de puissance. null = lue dans la
//   carte ($30 pour Grbl).

export const PROFILES = {
  cnc: {
    id: 'cnc', label: 'CNC Grbl (fraiseuse)', firmware: 'grbl', laser: false,
  },
  'laser-grbl': {
    id: 'laser-grbl', label: 'Laser Grbl ($32=1)', firmware: 'grbl', laser: true, sMax: null, defaultSMax: 1000,
  },
  emblaser2: {
    id: 'emblaser2', label: 'Emblaser 2 (Smoothieware)', firmware: 'smoothie', laser: true, sMax: 1, defaultSMax: 1,
    // Surface de travail annoncée par Darkly Labs : 500 × 300 mm, 50 mm en Z.
    area: { X: 500, Y: 300, Z: 50 },
  },
};

export const DEFAULT_PROFILE = 'cnc';

export const profileOf = (id) => PROFILES[id] || PROFILES[DEFAULT_PROFILE];

// Valeur S pour 100 % de puissance.
export function laserSMax(profile, settings = {}) {
  if (profile.sMax) return profile.sMax;
  const fromBoard = Number(settings[30]);
  return fromBoard > 0 ? fromBoard : profile.defaultSMax || 1000;
}
