/**
 * Generated by orval v6.2.4 🍺
 * Do not edit manually.
 * Swagger Petstore
 * OpenAPI spec version: 1.0.0
 */
import type {
  Pets,
  ListPetsParams,
  CreatePetsBody,
  Pet
} from '../model'
import { customInstance } from '../mutator/custom-instance'


  /**
 * @summary List all pets
 */
export const listPets = <TData = Pets>(
    params?: ListPetsParams,
    version= 1,
 ) => {
      return customInstance<TData>(
      {url: `/v${version}/pets`, method: 'get',
        params,
    },
      );
    }
  
/**
 * @summary Create a pet
 */
export const createPets = <TData = void>(
    createPetsBody: CreatePetsBody,
    version= 1,
 ) => {
      return customInstance<TData>(
      {url: `/v${version}/pets`, method: 'post',
      data: createPetsBody
    },
      );
    }
  
/**
 * @summary Info for a specific pet
 */
export const showPetById = <TData = Pet>(
    petId: string,
    version= 1,
 ) => {
      return customInstance<TData>(
      {url: `/v${version}/pets/${petId}`, method: 'get'
    },
      );
    }
  
