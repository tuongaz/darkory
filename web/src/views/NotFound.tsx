import { Link } from "react-router";

export function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p>
        Nothing lives at this address. Back to the <Link to="/">Board</Link>.
      </p>
    </>
  );
}
