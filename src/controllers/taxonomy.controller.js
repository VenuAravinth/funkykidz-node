// Controllers for categories and brands, built from their service.
export function makeTaxonomyController(service, key) {
  return {
    list: (req) => service.list(req.query),
    options: async () => ({ items: await service.options() }),
    get: async (req) => ({ [key]: await service.get(req.params.id) }),
    create: async (req, reply) => reply.code(201).send({ [key]: await service.create(req.body) }),
    update: async (req) => ({ [key]: await service.update(req.params.id, req.body, req.log) }),
    remove: (req) => service.remove(req.params.id),
  };
}
