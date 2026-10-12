import { removeCliStateSandbox } from "./cli-state-sandbox";

export function setup(): () => void {
  return () => {
    removeCliStateSandbox();
  };
}
