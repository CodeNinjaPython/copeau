import globals from 'globals';

// Vérification minimale mais vitale : aucune variable utilisée sans être
// déclarée (une déclaration effacée par erreur a déjà grisé les boutons de zéro).
export default [
  {
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['server/**/*.js', 'desktop/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: { 'no-undef': 'error' },
  },
];
