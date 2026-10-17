import * as Users from "../controllers/user.controller.js";
import * as S from "../schemas/user.schema.js";

// /api/v1/users — accounts that sign in to the ERP Admin Portal.
export default async function userRoutes(app) {
  app.get("/", { schema: S.userListSchema }, Users.list);
  app.post("/", { schema: S.userCreateSchema }, Users.create);
  app.post("/authenticate", { schema: S.authenticateSchema }, Users.authenticate);
  app.get("/:id", { schema: S.userIdSchema }, Users.get);
  app.patch("/:id", { schema: S.userUpdateSchema }, Users.update);
  app.put("/:id/password", { schema: S.userPasswordSchema }, Users.setPassword);
  app.post("/:id/sign-out", { schema: S.userIdSchema }, Users.signOut);
  app.get("/:id/auth", { schema: S.userIdSchema }, Users.getAuth);
  app.patch("/:id/auth", { schema: S.authUpdateSchema }, Users.updateAuth);
}
