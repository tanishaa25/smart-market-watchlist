import { describe, it, expect, vi } from "vitest";
import { signToken, authenticate } from "../auth.js";

function makeReq({ header, cookie }) {
  return { headers: { authorization: header }, cookies: cookie ? { token: cookie } : {} };
}
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

describe("authenticate — header-first, cookie-fallback", () => {
  it("authenticates via the Authorization header when present", () => {
    const token = signToken("user123");
    const req = makeReq({ header: `Bearer ${token}` });
    const next = vi.fn();
    authenticate(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBe("user123");
  });

  it("falls back to the httpOnly cookie when no header is present", () => {
    const token = signToken("user123");
    const req = makeReq({ cookie: token });
    const next = vi.fn();
    authenticate(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBe("user123");
  });

  it("rejects with 401 when neither header nor cookie is present", () => {
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("prefers the header over the cookie when both are present", () => {
    const headerToken = signToken("user123");
    const cookieToken = signToken("user456");
    const req = makeReq({ header: `Bearer ${headerToken}`, cookie: cookieToken });
    authenticate(req, makeRes(), () => {});
    expect(req.userId).toBe("user123");
  });
});
