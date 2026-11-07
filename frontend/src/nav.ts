/** Navega para outra página do app (mesmo efeito de clicar no menu).
 * O App escuta o "popstate" e troca a seção. */
export function irPara(path: string) {
  if (window.location.pathname !== path) window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}
