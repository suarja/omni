import { useCallback, useEffect, useRef, useState } from "react";

import { rootDestination, type Route } from "./navigation";

export type RouteHistory = Readonly<{
  canGoBack: boolean;
  canGoForward: boolean;
  onForward: () => void;
  onBack: () => void;
}>;

/**
 * The shell's Back and Forward history (D3): pushes the previous route whenever the screen changes
 * within the same sidebar destination, and resets when the destination itself changes (a
 * destination is a root, so Back never crosses `Home | Library | Projects | Review | Settings |
 * Activity`). `returnTo` routes stay the explicit path; canvas views use this history through their navigation shortcuts.
 */
export function useRouteHistory(route: Route | null, setRoute: (route: Route) => void): RouteHistory {
  const stackRef = useRef<Route[]>([]);
  const forwardRef = useRef<Route[]>([]);
  const previousRouteRef = useRef<Route | null>(null);
  const previousDestinationRef = useRef<string | null>(null);
  const suppressNextPushRef = useRef(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    if (route === null) return;
    const destination = rootDestination(route);
    const previousRoute = previousRouteRef.current;
    const previousDestination = previousDestinationRef.current;
    if (suppressNextPushRef.current) {
      suppressNextPushRef.current = false;
    } else if (previousRoute && previousDestination === destination) {
      if (JSON.stringify(previousRoute) !== JSON.stringify(route)) {
        stackRef.current = [...stackRef.current, previousRoute];
        forwardRef.current = [];
      }
    } else {
      stackRef.current = [];
      forwardRef.current = [];
    }
    previousRouteRef.current = route;
    previousDestinationRef.current = destination;
    setCanGoBack(stackRef.current.length > 0);
    setCanGoForward(forwardRef.current.length > 0);
  }, [route]);

  const onBack = useCallback((): void => {
    if (stackRef.current.length === 0) return;
    const previous = stackRef.current[stackRef.current.length - 1];
    if (previousRouteRef.current) forwardRef.current.push(previousRouteRef.current);
    setCanGoForward(true);
    stackRef.current = stackRef.current.slice(0, -1);
    suppressNextPushRef.current = true;
    setCanGoBack(stackRef.current.length > 0);
    setRoute(previous);
  }, [setRoute]);

  const onForward = useCallback((): void => {
    const next = forwardRef.current.pop();
    if (!next) return;
    if (previousRouteRef.current) stackRef.current.push(previousRouteRef.current);
    suppressNextPushRef.current = true;
    setCanGoBack(stackRef.current.length > 0);
    setCanGoForward(forwardRef.current.length > 0);
    setRoute(next);
  }, [setRoute]);
  return { canGoBack, onBack, canGoForward, onForward };
}
