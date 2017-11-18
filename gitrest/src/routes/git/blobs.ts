import { Router } from "express";
import { IBlob, ICreateBlobParams, ICreateBlobResponse } from "gitresources";
import * as nconf from "nconf";
import * as utils from "../../utils";

/**
 * Validates that the input encoding is valid
 */
function validateEncoding(encoding: string) {
    return encoding === "utf-8" || encoding === "base64";
}

function validateBlob(blob: string): boolean {
    return blob !== undefined && blob !== null;
}

export async function getBlob(repoManager: utils.RepositoryManager, repo: string, sha: string): Promise<IBlob> {
    const repository = await repoManager.open(repo);
    const blob = await repository.getBlob(sha);

    return utils.blobToIBlob(blob, repo);
}

export async function createBlob(
    repoManager: utils.RepositoryManager,
    repo: string,
    blob: ICreateBlobParams): Promise<ICreateBlobResponse> {

    if (!blob || !validateBlob(blob.content) || !validateEncoding(blob.encoding)) {
        return Promise.reject("Invalid blob");
    }

    const repository = await repoManager.open(repo);
    const id = await repository.createBlobFromBuffer(new Buffer(blob.content, blob.encoding));
    const sha = id.tostrS();

    return {
        sha,
        url: `/repos/${repo}/git/blobs/${sha}`,
    };
}

export function create(store: nconf.Provider, repoManager: utils.RepositoryManager): Router {
    const router: Router = Router();

    router.post("/repos/:repo/git/blobs", (request, response, next) => {
        const blobP = createBlob(repoManager, request.params.repo, request.body as ICreateBlobParams);
        return blobP.then(
            (blob) => {
                response.status(201).json(blob);
            },
            (error) => {
                response.status(400).json(error);
            });
    });

    /**
     * Retrieves the given blob from the repository
     */
    router.get("/repos/:repo/git/blobs/:sha", (request, response, next) => {
        const blobP = getBlob(repoManager, request.params.repo, request.params.sha);
        return blobP.then(
            (blob) => {
                response.status(200).json(blob);
            },
            (error) => {
                response.status(400).json(error);
            });
    });

    return router;
}
