export interface SandboxServiceLink {
  port: number;
  label: string;
  href: string;
}

export function serviceLinks(
  fqdn: string | null,
  services: readonly { port: number }[],
): SandboxServiceLink[] {
  if (fqdn === null || fqdn === "") return [];
  return services.map((service) => ({
    port: service.port,
    label: `${fqdn}:${service.port}`,
    href: `https://${fqdn}:${service.port}`,
  }));
}
