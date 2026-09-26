import { useLocation } from 'react-router';

/** Tests only: shows the router location (path, and the state as JSON in data-state). */
export function TestLocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location" data-state={JSON.stringify(location.state ?? null)}>
      {location.pathname + location.search + location.hash}
    </output>
  );
}
