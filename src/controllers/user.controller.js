import { UserService } from "../services/user.service.js";

// /api/v1/users — ERP Admin Portal login accounts.
export const list = (req) => UserService.list(req.query);
export const get = async (req) => ({ user: await UserService.get(req.params.id) });
export const create = async (req, reply) => reply.code(201).send({ user: await UserService.create(req.body) });
export const update = async (req) => ({ user: await UserService.update(req.params.id, req.body) });
export const setPassword = async (req) => ({ user: await UserService.setPassword(req.params.id, req.body.password) });
export const signOut = async (req) => ({ user: await UserService.signOutEverywhere(req.params.id) });

// Sign-in steps, called by the portal's server only.
export const authenticate = (req) => UserService.authenticate(req.body);
export const getAuth = (req) => UserService.getAuth(req.params.id);
export const updateAuth = (req) => UserService.updateAuth(req.params.id, req.body);
