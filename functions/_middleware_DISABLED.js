export async function onRequest({ request, next }) {
  const host = request.headers.get("host") || "";
  const url = new URL(request.url);

  // If someone uses the default Pages domain, kick them to the .app domain.
  if (host.endsWith(".pages.dev")) {
    url.host = "onlinedevtools.app";
    return Response.redirect(url.toString(), 301);
  }

  return next();
}