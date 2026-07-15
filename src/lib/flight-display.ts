export interface FlightRouteDisplay {
  departure: string
  departureName?: string
  departureTerminal?: string
  arrival: string
  arrivalName?: string
  arrivalTerminal?: string
}

function airportDisplayName(code: string, name?: string, terminal?: string): string {
  const base = (name || code).trim()
  if (!terminal) return base
  const normalized = terminal.startsWith('T') ? terminal : terminal.replace(/[()]/g, '')
  if (base.includes(normalized) || base.includes(`(${normalized})`)) return base
  return `${base}(${normalized})`
}

export function flightRouteCell(route: FlightRouteDisplay): string {
  return `${route.departure}${route.arrival} ${airportDisplayName(route.departure, route.departureName, route.departureTerminal)} → ${airportDisplayName(route.arrival, route.arrivalName, route.arrivalTerminal)}`
}
