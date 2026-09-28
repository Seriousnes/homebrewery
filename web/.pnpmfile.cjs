// pnpm install hooks.
module.exports = {
  hooks: {
    readPackage(pkg) {
      // openapi-typescript (`pnpm run api:types`) builds its output with the TypeScript compiler API,
      // which TypeScript 7 (the project's compiler) no longer ships. It gets TypeScript 5 of its own
      // instead of the project's through its peer dependency.
      if (pkg.name === 'openapi-typescript') {
        delete pkg.peerDependencies?.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: '5.9.3' };
      }
      // marked-hbfm lists its ESLint plugins as runtime dependencies; it never imports them.
      if (pkg.name === 'marked-hbfm') {
        delete pkg.dependencies?.['eslint-plugin-jest'];
        delete pkg.dependencies?.['eslint-plugin-react'];
      }
      return pkg;
    },
  },
};
