// Raw HTML templates are imported as text modules (wrangler maps **/*.html → Text).
declare module "*.html" {
  const content: string;
  export default content;
}
