import { useEffect, useRef } from 'react';

/**
 * True while the component is mounted. For callbacks that land after an await: a session the
 * user already left (its unmount save finished later) must not navigate or adopt anything.
 */
export function useMountedRef() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
