import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { LiveActivity } from "../api/live";
import { Providers, Root } from "../App";
import { newQueryClient } from "../queryClient";

/** Renders the whole app at `path`, as the browser would after loading it there. */
export function renderApp(path = "/") {
  const client = newQueryClient();
  const live = new LiveActivity();
  const result = render(
    <Providers client={client} live={live}>
      <MemoryRouter initialEntries={[path]}>
        <Root />
      </MemoryRouter>
    </Providers>,
  );
  return { ...result, client, live };
}
