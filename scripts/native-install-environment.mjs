/** Ensures clean-install proofs exercise required native dependency builds. */
export function nativeInstallEnvironment(environment = process.env) {
  const prepared = { ...environment, npm_config_ignore_scripts: 'false' }
  delete prepared.NPM_CONFIG_IGNORE_SCRIPTS
  return prepared
}
